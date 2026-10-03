# 本地 HyperLogLog 近似去重计数与集合合并服务

使用 TypeScript + Node.js（内置 `node:sqlite`）从零实现的基础 HyperLogLog 后端，只提供 HTTP API 与 CLI，无前端、无 Docker/WSL、无外部在线服务。

本服务只做**近似基数（不同键数量）估计**：

- 不提供单个键的成员查询（不能回答“某键是否出现过”）；
- 不保存任何业务键——正式计数器里只有固定数量的寄存器（每寄存器 1 字节）；
- 结果是**估计值**，不是精确数量；演示脚本中的精确集合（`Set`）只用于独立对照验证，不参与正式计数。

## 环境要求

- Windows + Node.js 22.5+（内置 `node:sqlite`，开发验证使用 Node 25.5.0）
- 无需安装任何数据库服务，SQLite 以库形式内嵌运行

## 快速开始

```powershell
npm install
npm run build     # 编译到 dist-test/
npm test          # 构建 + 运行 23 个测试
npm run demo      # 固定小数据演示（精确集合对照、合并、重启续加）
npm start         # 启动 HTTP 服务，默认自动选择空闲端口
```

指定端口与数据文件：

```powershell
node dist-test/src/cli.js serve --port 8080 --db ./data/hll.db
```

启动后输出一行 JSON，形如 `{"status":"listening","host":"127.0.0.1","port":52622,"db":"..."}`，只监听本机回环地址。数据默认放在项目内 `./data/`。

## 规则版本与位序（HLL-V1-SHA256-64）

1. 精度 `p` 限定整数 4..12，寄存器数 `m = 2^p`（16..4096）。
2. 对键的 **UTF-8 原始字节**计算 SHA-256，取摘要前 8 个字节（前 64 位），按**大端序**（高位在前）解释为无符号 64 位整数。不使用现成 HLL 库，只调用 Node 的哈希函数。
3. 哈希最高 `p` 位为**寄存器编号**（桶号）。
4. 剩余 `w = 64 - p` 位称为尾部：从尾部最高位开始数连续 0 的个数 `z`，秩 `rank = z + 1`；尾部全零时 `rank = w + 1`（最大 61，当 p=4）。
5. 寄存器只保留落入该桶的所有键中见过的**最大秩**。
6. 空字符串 `""` 是有效键；不做大小写转换、不做空白修剪（`"A"`、`"a"`、`" A"` 是不同键）。
7. 哈希算法、位序与取值规则整体标记为版本 `HLL-V1-SHA256-64`，与精度、哈希名一起持久化，合并时强校验。

## 估计公式

原始调和平均数估计：

```
E = alpha_m × m² / Σ (2^(-R[j]))     j = 0..m-1
```

修正系数：

| m | alpha_m |
|---|---|
| 16 | 0.673 |
| 32 | 0.697 |
| 64 | 0.709 |
| ≥128 | 0.7213 / (1 + 1.079/m) |

小基数校正（线性计数）：当 `E ≤ 2.5m` 且存在 `V` 个零寄存器时，改用 `E* = m × ln(m/V)`；全部寄存器为零（空计数器）时估计为 0。

估计接口同时返回：`rawEstimate`（原始 E）、`correctedEstimate`（校正结果）、`zeroRegisters`（V）、`theoreticalRse`（约 `1.04/√m` 的理论相对标准误差）与说明文字。

**关于标准误差**：`1.04/√m` 是大量独立估计的统计标准差参考，**不是单次估计必然满足的误差界**；本实现不做大基数修正、不做稀疏模式、不带偏差校正表，目标规模为演示与中小基数场景。不同 p 的理论 RSE：p=4 约 26.0%，p=8 约 6.5%，p=10 约 3.25%，p=12 约 1.6%。

## 合并规则

- 仅允许**精度、哈希名、规则版本完全一致**的计数器/快照合并，否则返回错误（`INCOMPATIBLE_PRECISION` / `INCOMPATIBLE_RULE_VERSION` / `INCOMPATIBLE_HASH`）。
- 合并为逐位置取寄存器最大值，生成**新快照**并保留来源列表；绝不直接相加两个估计值，也不修改来源计数器。
- 因此合并天然满足交换律、结合律、幂等律；“先合并再继续加入”与“对同一键集合直接计算”寄存器完全一致（测试覆盖）。

## 内存与持久化

- 内存占用固定为每计数器 `m` 字节：p=4 为 16 B，p=8 为 256 B，p=12 为 4096 B，与加入键数量无关。
- SQLite 两张表：`counters`（计数器 + BLOB 寄存器 + 版本字段）与 `snapshots`（合并快照 + 来源 JSON）。
- 寄存器更新在单个 `BEGIN IMMEDIATE` 事务内原子写入（WAL 模式）；重复加入相同键不产生变化。重启进程后可继续加入同一计数器。
- 读取与导入时校验寄存器长度必须等于 `2^p`、每个秩必须在 `0..(64-p+1)` 内，损坏状态以 `CORRUPT_STATE` / `INVALID_REGISTER_LENGTH` / `INVALID_RANK` 拒绝；导入整体在事务中进行，任一记录非法则全部回滚。
- 不支持删除单个键（HLL 寄存器无法撤销贡献）。

## HTTP API

所有错误返回 `{"error":{"code":...,"message":...}}`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| POST | `/api/counters` | 创建计数器，body：`{"name":"visits","p":10}` |
| GET | `/api/counters` | 列出计数器 |
| POST | `/api/counters/:name/add` | 批量加入，body：`{"keys":["a","b",""]}`（必须是字符串数组） |
| GET | `/api/counters/:name/registers` | 查看全部寄存器值与非零数量 |
| GET | `/api/counters/:name/estimate` | 原始/校正估计、零寄存器数、RSE 说明 |
| POST | `/api/merge` | 生成合并快照，body：`{"snapshotName":"d1","sources":[{"kind":"counter","name":"visits"}]}`，`kind` 为 `counter` 或 `snapshot` |
| GET | `/api/snapshots` / `/api/snapshots/:name` | 快照列表 / 快照详情（含来源与估计） |
| GET | `/api/export` | 导出全部状态（寄存器 base64 + 版本） |
| POST | `/api/import` | 导入状态（整体事务，损坏即拒绝） |

主要错误码：`INVALID_PRECISION`(400)、`INVALID_KEYS`(400)、`INVALID_REGISTER_LENGTH`(400)、`INVALID_RANK`(400)、`NOT_FOUND`(404)、`ALREADY_EXISTS`(409)、`INCOMPATIBLE_*`(409)、`CORRUPT_STATE`(500)。

PowerShell 调用示例：

```powershell
Invoke-RestMethod http://127.0.0.1:8080/api/counters -Method POST -ContentType 'application/json' `
  -Body (@{ name='visits'; p=10 } | ConvertTo-Json)
Invoke-RestMethod http://127.0.0.1:8080/api/counters/visits/add -Method POST -ContentType 'application/json' `
  -Body (@{ keys=@('alice','bob','alice') } | ConvertTo-Json)
Invoke-RestMethod http://127.0.0.1:8080/api/counters/visits/estimate
```

## CLI

```powershell
node dist-test/src/cli.js create visits --p 10
node dist-test/src/cli.js add visits --keys "alice,bob,alice,,"          # 含空字符串
node dist-test/src/cli.js add visits --keys-file keys.json               # JSON 字符串数组
node dist-test/src/cli.js registers visits
node dist-test/src/cli.js estimate visits
node dist-test/src/cli.js merge day1 --sources counter:visits,counter:other
node dist-test/src/cli.js snapshot day1
node dist-test/src/cli.js list
node dist-test/src/cli.js export --file state.json
node dist-test/src/cli.js import --file state.json
node dist-test/src/cli.js serve --port 8080
```

所有命令可用 `--db 路径` 指定数据库，默认 `./data/hll.db`。

## 测试

- `test/hll.test.ts`：注入固定 64 位哈希（构造的大整数及测试用 FNV-1a）核对分桶编号与零计数；覆盖空计数器、全重复输入不变、同桶秩覆盖、全零尾部秩 `w+1`、空串/大小写/空白不归一、非法精度、非法寄存器长度与越界秩；合并的交换/结合/幂等、先合并再加入与直接并集一致、三类兼容性拒绝；小数据与精确集合对照。
- `test/store.test.ts`：SQLite 持久化与重启续加、快照来源保留、损坏 BLOB 拒绝、导出导入一致性与坏数据整体回滚。
- `test/http.test.ts`：API 全流程与 HTTP 错误码。

演示（`npm run demo`）使用固定的几组小数据与独立 `Set` 精确数量对照展示估计偏差；测试**不**要求所有样本落在理论标准误差内。

## 项目结构

```
src/hll.ts     核心 HLL：哈希、分桶、计秩、估计、合并、寄存器校验
src/store.ts   SQLite 持久化（事务、损坏校验、导入导出）
src/service.ts 业务编排（不直接相加估计）
src/http.ts    HTTP API 与空闲端口探测
src/cli.ts    CLI 入口
src/demo.ts    演示与精确集合对照
test/          node:test 测试
data/          运行时数据目录（自动创建）
```

## 已知限制

- 仅实现小基数线性计数校正，不含大基数修正、稀疏表示与偏差表；超大基数下可能出现轻微系统偏差。
- 只使用 SHA-256 前 64 位；不可回退到保存原始键的“精确模式”。
- 不能删除键、不能做单键成员判定、不能给出精确数量或误差保证。
- `node:sqlite` 在当前 Node 版本仍标记为实验性，运行时会有一条 ExperimentalWarning，不影响功能。
