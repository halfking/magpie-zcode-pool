# magpie-zcode-pool

把 **zcode-switcher 留在本机的 ZCode 账号池**，作为 magpie 的一个 provider 端出去。

magpie 上游把 ZCode 内置迁到了社区插件（`@magpie-community/opencode-zcode-auth`），
那是**一个账号**的服务。这个插件补上另一半：zcode-switcher 可以在本机存多个 ZCode
账号，某个账号的套餐额度用完时自动切到下一个——magpie 原生就有账号/额度/路由组这些
机制，这里把 zcode-switcher 的账号池接进 magpie 的同一个 provider 里。

- provider id：`zcode-pool`
- 模型：`GLM-5.3`、`GLM-5.3-Flash`、`GLM-5.2`、`GLM-5-Turbo`
- 账号来源：`~/.zcode/v2/account-profiles/`（zcode-switcher 写的账号池）
  - `profiles.json`：每个已登录账号一条（`name` / `family` / `cred_file` / `provider_api_keys`）
  - `credentials.<id>.json`：该账号的凭据，其中
    `account-provider:coding-plan:account:<family>-individual-coding-plan:account:<id>:api-key`
    就是这个账号的 coding plan key

## 三件事

### 1. 换帐号登录

登录时选池里的哪个账号：

```sh
magpie plugin login zcode-pool
# Sign in as which account of the pool?
#   1. yrarnh58  bigmodel
#   2. ciorf900  bigmodel
#   3. pcwelcl0  bigmodel
```

**每登录一次，就是 magpie 里的一个独立账号**（插件宿主给每个 sign-in 一个
`provider#slot` 的账号位）。于是：

- magpie 的账号页里能同时看到池里的多个账号，各自带自己的额度卡；
- 账号在界面里**以池里的名字出现**（`yrarnh58`、`pcwelcl0`、账号自己的邮箱），
  而不是一串 key 掩码——插件把名字写进 sign-in 的 `metadata.email`，magpie 就用它
  当这个账号的身份；
- 路由组可以按 `smart` / `usage` / `rotate` / `pace` 在它们之间挑（magpie 原生能力）；
- 想换号，就再登录一次，选另一个。

登录不需要粘贴 key：插件直接读本机账号池（`keyless`）。

### 2. 用量 / 额度

每个账号的额度由插件自己读（`auth.usage`），报给 magpie，于是 magpie 的
**额度卡、Usage 页、菜单栏**都显示它：

- 数据来自 `open.bigmodel.cn/api/monitor/usage/quota/limit`（z.ai 的账号走 `api.z.ai`），
  与 zcode-switcher 自己显示的「积分 988/2,000、周积分 991/1万」同源；
- 窗口按厂商的编码还原：5 小时（`unit=3,number=5`）、周（`6,1`）、月（`5,1`）；
- 积分桶（`CREDIT_LIMIT`）给绝对值与百分比，token 桶（`TOKENS_LIMIT`）给百分比，
  工具额度（`TIME_LIMIT`）作为脚注（`MCP · Month`），因为它不拦模型；
- 套餐名（`GLM Coding Lite` / `Max`）与到期/续费时间也一起报上来。

实测（本机 3 个账号）：

```
zcode-pool · GLM Coding Lite · expires Dec 15 · …gDQn  5h 0% (1 / 2000)      Weekly 59% (5941 / 10000)
zcode-pool · GLM Coding Max · renews May 24  · …R3aM  Weekly Tokens 100%       MCP Month 2% (91 / 4000)
zcode-pool · GLM Coding Max · renews Sep 12  · …XIcp  5h 4% (1259 / 28000)    Weekly 1% (1259 / 140000)
```

### 3. 额度耗尽时的池内回退

登录的那个账号额度用完时，插件自动换一个池里的账号接着服务（可关）。

- provider 选项 **「Plan spent: serve another account of the pool」**（默认开）：
  - 开：账号额度耗尽 → 池里另一个账号接管，请求照常成功；
  - 关：请求就失败，由 magpie 自己的路由组换到另一个 magpie 账号。
- 厂商在 429 里会说明额度何时重置，插件记下那个时间，重置前不再问这个账号。

实测：登录的是额度已 100% 的账号，请求照样 **200**（池里另一个账号接管）。

## 装上

```sh
magpie plugin add /path/to/magpie-zcode-pool   # 本地目录，magpie 就地加载，不拷贝
magpie plugin login zcode-pool                 # 登录 = 读本机账号池 + 选账号
```

验证：

```sh
magpie quota | grep zcode-pool                 # 三个账号的额度卡
curl http://127.0.0.1:3425/v1/chat/completions \
  -H 'Authorization: Bearer magpie' -H 'Content-Type: application/json' \
  -d '{"model":"zcode-pool/GLM-5.2","messages":[{"role":"user","content":"say ok"}]}'
```

## 它怎么工作

1. **读池**：`readPool()` 读 `profiles.json` 与每个账号的凭据，取出 coding plan key。
   池里没有账号时，登录会直说「本机没有 ZCode 账号可读」，让你先去 zcode-switcher 登录。
2. **解 key**：ZCode 把凭据里的值加密存放（`enc:v1:<iv>.<tag>.<data>`，AES-256-GCM，
   密钥是 `sha256("zcode-credential-fallback:<platform>:<home>:<user>")`，或
   `ZCODE_CREDENTIAL_SECRET`）。直接拿密文去请求会得到 401
   （「令牌已过期或验证不正确」）——**这是本插件第一版踩到的坑**。解不开、或解出来不像
   key（不含 `.`、含占位符）的账号被跳过。
3. **轮换**：请求先给登录的那个账号；厂商回 429/402/401/403 时换下一个账号重试同一个
   请求（请求体读一次、发多次）。
4. **额度**：读额度时**串行 + 间隔 + 重试**——厂商在几个账号同时被问时会掐掉部分连接
   （socket closed），串行读并各重试 3 次才稳；读到的结果缓存 60 秒。

## 已知边界

- **面板（P5）读不到本机文件**：magpie 的社区面板跑在 `sandbox allow-scripts` 的 iframe 里，
  `connect-src 'none'`，只能读 magpie 声明的接口（`usage:summary`、`providers:list`）和自己的
  options。所以本插件 v1 **不自带面板**，账号池的状态由 magpie 自己的 provider 卡片/额度卡显示。
- **不覆盖官方插件的登录流程**：这里只管「用哪个账号发请求」，不负责 OAuth 登录、
  团队席位、Start Plan 这些——那些仍由 `@magpie-community/opencode-zcode-auth` 负责。
  两个插件并存：`zcode/*` 是官方单账号，`zcode-pool/*` 是本机账号池。
- **账号池以 zcode-switcher 为准**：本插件只读不写它的目录。换账号、导入导出账号，
  仍在 zcode-switcher 里做。

## 踩过的坑（留给下一个改这里的人）

- **插件选项的 key 必须全小写**（宿主用 `[a-z0-9_-]{1,40}` 校验）。写成 `poolFallback`
  会被**静默丢弃** ⇒ `magpie.option()` 只会返回 `false` ⇒ 回退被当成"关掉了"。
  同理，`magpie.option()` 对"没声明的 key"也返回 `false`，要区分"用户关了"和"没声明"
  得读 `magpie.options()` 整个对象。
- **额度不能并发读**：三个账号同时问厂商，部分连接会被直接掐掉，报
  「The socket connection was closed unexpectedly」。串行 + 间隔 + 重试可解。
- **厂商的 401 有两种含义**：密钥没解密（密文直发）与额度耗尽后的 token 失效，
  都要看自己发出去的是什么。

## 与 zcode-switcher 的关系

- zcode-switcher：`halfking/zcode-switcher` —— ZCode 账号池的本机管理者（Tauri 桌面应用）
- 本插件：`halfking/magpie-zcode-pool` —— 把那个账号池接进 magpie 的网关
- magpie：`halfking/magpie` —— 网关与界面

## 许可

MIT。凭据的解密方式与模型清单参照了 `magpie-community/plugins` 的
`packages/zcode`（同为 MIT）。
