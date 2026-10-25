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

## 五件事

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

**删掉一个账号**（比如那个号已经废了）：

- 界面上：那个账号卡片的「移除」——只删这一个（magpie 的单账号 sign-out）；
- 命令行：`magpie plugin logout zcode-pool` 是**把该 provider 的账号全清空**，
  不是删单个；要留到只剩一个号时用它更合适。

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

### 4. 重置卡（只读）

额度卡上还多一行 **↺ 重置次数**：这个账号手里还有几张能回满额度的卡。

- 数据来自 `open.bigmodel.cn/api/biz/customer-package-reset/list?targetType=PERSONAL`，
  与 magpie 核心读自己那份 GLM Coding 套餐用的是**同一个接口**（`zcode_team.go`），
  所以插件的读数与原生 GLM Coding 卡片的口径一致。
- 只数还可用（`available`）的：已过期的卡还会在列表里挂一周，按不可用剔除。
- 分两档报：**5 小时重置** 与 **周重置** 各几张，并给出最早过期时间。
- **只读**：卡在哪里用仍在 zcode-switcher 里做，本插件不去动卡。

实测（本机 3 个账号）：

```
zcode-pool · GLM Coding Max · renews May 24 · 56****81@qq.com  ↺ 3 five-hour resets · 3 weekly resets until Wed 12:05
zcode-pool · GLM Coding Lite · expires Dec 15 · pcwelcl0       ↺ 3 weekly resets until Dec 22 23:59
zcode-pool · GLM Coding Max · renews Sep 12 · yrarnh58         ↺ 4 five-hour resets · 3 weekly resets until Wed 12:08
```

### 5. 赠券（只读）

额度卡上还有 **-Trial 的条目**：这个账号手里另有一份赠券额度（ZCode 1024 Dev Day / Start Plan），
它和 coding plan 的 5 小时 / 周窗口是**两套**。

- 数据来自 `zcode.z.ai/api/v1/zcode-plan/billing/balance`，用账号自己的 **ZCode 会话 JWT**
  读（池里每个账号的凭据里都有 `zcodejwttoken`），和 ZCode 自己读它的方式一样。
- 每个还在的桶（bucket）给一行：模型名用挑选器里的写法（`GLM-5.3-Trial`、`GLM-5.3-Flash-Trial`），
  加上用了多少 / 一共多少，以及这个桶什么时候到期。
- **已耗尽的桶不显示**（ciorf900 的 GLM-5.3 赠券就是 0，所以卡片上只有 Flash 那一条）。
- **只读，而且刻意不在这里花**：赠券只认 **ZCode 的登录身份**，key 花不了它
  （实测：拿普通 Anthropic 请求打赠券端点 → `405 / 3012 request has been blocked due to
  unusual activity`，ZCode 只认「像它自己发出来的」请求）。
  ⇒ 要花赠券，**在 zcode-switcher 里把 ZCode 切到那个账号**，官方
  `@magpie-community/opencode-zcode-auth` 就会用它；本插件只负责告诉你每个账号还剩多少。

实测（本机 3 个账号）：

```
zcode-pool · GLM Coding Max  · 56****81@qq.com  GLM-5.3-Flash-Trial 76% (227192507 / 300000000)
zcode-pool · GLM Coding Lite · pcwelcl0         GLM-5.3-Flash-Trial 36% (108428769 / 300000000)
                                               GLM-5.3-Trial        32% ( 64542106 / 200000000)
zcode-pool · GLM Coding Max  · yrarnh58         GLM-5.3-Flash-Trial  9% ( 28409088 / 300000000)
                                               GLM-5.3-Trial        95% (189653493 / 200000000)
```

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
5. **重置卡**：同一把计划 key 读厂商的重置卡列表，数还可用几张；读不到就不报，
   不让这一项拖垮整张额度卡。
6. **赠券**：用账号的 ZCode 会话 JWT（凭据里的 `zcodejwttoken`）读赠券余额，
   把每个还在的桶变成一行 `-Trial` 窗口。读不到就不报，同样不拖累整张卡。

## 已知边界

- **面板（P5）读不到本机文件**：magpie 的社区面板跑在 `sandbox allow-scripts` 的 iframe 里，
  `connect-src 'none'`，只能读 magpie 声明的接口（`usage:summary`、`providers:list`）和自己的
  options。所以本插件 v1 **不自带面板**，账号池的状态由 magpie 自己的 provider 卡片/额度卡显示。
- **不覆盖官方插件的登录流程**：这里只管「用哪个账号发请求」，不负责 OAuth 登录、
  团队席位、Start Plan 这些——那些仍由 `@magpie-community/opencode-zcode-auth` 负责。
  两个插件并存：`zcode/*` 是官方单账号，`zcode-pool/*` 是本机账号池。
- **账号池以 zcode-switcher 为准**：本插件只读不写它的目录。换账号、导入导出账号，
  仍在 zcode-switcher 里做。
- **重置卡只读**：卡的数量与过期时间报上来，但**用卡**是 zcode-switcher 的动作
  （`/api/biz/customer-package-reset/use` 会真的扣卡），本插件不代劳。
- **赠券只读，且不在这里花**：赠券（1024 Dev Day）只认 **ZCode 的登录身份**，
  key 花不了它（实测普通 Anthropic 请求会被 `405 / 3012` 挡掉）。所以本插件
  **不把 `-Trial` 模型放进可挑的模型表**——放了就是「能选但发不出去」。
  要花赠券：在 **zcode-switcher 里把 ZCode 切到那个账号**，官方
  `@magpie-community/opencode-zcode-auth` 就会用上它；本插件只负责报出每个账号还剩多少。

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
