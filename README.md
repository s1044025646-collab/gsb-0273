# Windows 本地 HyperLogLog 近似去重服务

这是一个只包含后端 API 与 CLI 的本地近似基数（distinct count）服务，使用 TypeScript、Node.js 和内置 `node:sqlite`。服务保存固定长度 HLL 寄存器，不保存业务键集合，不支持成员查询，也不承诺精确数量。

## 环境要求

- Windows、PowerShell
- Node.js 25+（本项目在 Node.js 25.5.0 下验证）
- 不需要 Docker、WSL、付费服务或外部在线 API

## 快速开始

```powershell
npm install
npm run build
npm test
npm run demo
npm start -- serve
```

不显式传 `--port` 时自动选择空闲端口。固定端口：

```powershell
npm start -- serve --host 127.0.0.1 --port 5173
```

默认 SQLite 文件为项目内 `data/hll.sqlite`，可用 `HLL_DB` 替换：

```powershell
$env:HLL_DB="data/my-hll.sqlite"; npm start -- list
```

## 规则版本与位序

规则版本固定为 `HLL-SHA256-64-V1`：

1. 对原始 UTF-8 字符串计算 SHA-256。
2. 按大端字节序取摘要前 8 字节，即固定 64 位无符号整数。
3. 精度 `p` 只能是 4 到 12，寄存器数 `m = 2^p`，即 16 到 4096。
4. 64 位的最高 `p` 位作为寄存器编号。
5. 剩余 `64-p` 位从最高位向最低位统计连续前导零，秩 `rank = leadingZeros + 1`。
6. 剩余位全为零时，秩为 `(64-p)+1`。
7. 每个寄存器只保留历史最大秩。

空字符串是有效键；不会对大小写、前后空白或 Unicode 格式做自动归一。例如 `""`、`"A"`、`"a"`、`" a"` 是不同输入。

## 估计公式

原始估计：

```text
E = alpha × m² / Σ 2^(-register[j])
```

`alpha` 取值：

- `m=16`: `0.673`
- `m=32`: `0.697`
- `m=64`: `0.709`
- `m>=128`: `0.7213 / (1 + 1.079/m)`

当 `E <= 2.5m` 且存在 `V` 个零寄存器时，采用小范围校正：

```text
E' = m × ln(m / V)
```

API 和 CLI 同时返回原始估计、最终估计、是否使用小范围校正、零寄存器数量和理论相对标准误差：

```text
RSE ≈ 1.04 / sqrt(m)
```

该数值是统计意义上的理论相对标准误差，不是每次运行都保证满足的绝对误差界。本项目不实现大基数修正、稀疏模式或偏差表。

## 内存与持久化

| p | m | 理论 RSE |
|---:|---:|---:|
| 4 | 16 | 26.00% |
| 6 | 64 | 13.00% |
| 8 | 256 | 6.50% |
| 10 | 1024 | 3.25% |
| 12 | 4096 | 1.625% |

寄存器秩范围是 0 到 `64-p+1`。SQLite 保存寄存器、精度、哈希算法、哈希位数、规则版本和时间戳；读取时验证长度与秩范围，损坏状态返回 `INVALID_STATE`。

合并只允许精度、哈希算法、哈希位数和规则版本一致的计数器；逐位置取最大值，生成新快照并保存来源。不能把两个估计值直接相加。重复合并不改变结果，并满足交换律、结合律、幂等性质。

## HTTP API

```http
GET  /health
POST /counters
GET  /counters
GET  /counters/{name}
GET  /counters/{name}/registers
GET  /counters/{name}/estimate
POST /counters/{name}/keys
POST /snapshots
GET  /snapshots
GET  /snapshots/{name}
GET  /export
POST /import
```

创建计数器：

```json
{"name":"visits","precision":8}
```

批量加入：

```json
["", "user-1", "user-2", "user-1"]
```

合并快照：

```json
{"name":"visits-total","sources":["visits-a","visits-b"]}
```

单批限制 1 到 100000 个字符串。导入只接受 `local-hll-export` v1 JSON，并在事务中执行。

## CLI 示例

```powershell
npm start -- create visits 8
npm start -- add visits "" user-1 user-2 user-1
npm start -- registers visits
npm start -- estimate visits
npm start -- create mobile 8
npm start -- add mobile user-2 user-3
npm start -- merge total visits mobile
npm start -- snapshot total
npm start -- export data/export.json
npm start -- import data/export.json
```

从 JSON 数组文件批量加入：

```powershell
'["a","b","c"]' | Set-Content -Encoding UTF8 data/keys.json
npm start -- add visits --file data/keys.json
```

## 错误码

- `INVALID_PRECISION`: 精度不是 4 到 12 的整数
- `INVALID_NAME`: 名称格式不合法
- `INVALID_KEYS`: 加入内容不是字符串数组或批量大小越界
- `INVALID_REGISTERS`: 寄存器长度不等于 `2^p`
- `INVALID_RANK`: 寄存器秩超出允许范围
- `INVALID_STATE`: 导入或 SQLite 状态损坏
- `INCOMPATIBLE_COUNTERS`: 精度、哈希或规则版本不一致
- `COUNTER_NOT_FOUND` / `SNAPSHOT_NOT_FOUND`: 对象不存在
- `CONFLICT`: 名称冲突或并发更新冲突
- `BAD_REQUEST`: 其他请求格式错误
- `INTERNAL_ERROR`: 未预期服务端错误

## 测试与限制

测试使用可注入的固定 64 位哈希核对分桶和零计数，覆盖空计数器、全重复输入、秩覆盖、全零尾部、非法长度/秩、兼容性拒绝、合并交换/结合/幂等、先合并再加入一致性、SQLite 重启、导出导入和 HTTP API。

`npm run demo` 中的精确 `Set` 只用于小样本演示对照；正式计数器和 SQLite 中不保存全部键，不能用集合长度冒充 HLL 估计。

限制：不提供删除单个键或成员查询；结果是近似值；不实现大基数修正、稀疏模式、偏差表或多版本哈希迁移；当前规则版本只支持 SHA-256 前 64 位和本文位序。
