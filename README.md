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

## 装上

```sh
magpie plugin add /path/to/magpie-zcode-pool   # 本地目录，magpie 就地加载，不拷贝
magpie plugin login zcode-pool                 # 登录 = 读本机账号池，不用粘贴 key
```

登录后会多出这些模型：`zcode-pool/GLM-5.3`、`zcode-pool/GLM-5.2`……

验证：

```sh
curl http://127.0.0.1:3425/v1/chat/completions \
  -H 'Authorization: Bearer magpie' -H 'Content-Type: application/json' \
  -d '{"model":"zcode-pool/GLM-5.2","messages":[{"role":"user","content":"say ok"}]}'
```

## 它怎么工作

1. **读池**：`readPool()` 读 `profiles.json` 与每个账号的凭据，取出 coding plan key。
   池里没有账号时，登录会直说"本机没有 ZCode 账号可读"，让你先去 zcode-switcher 登录。
2. **解 key**：ZCode 把凭据里的值加密存放（`enc:v1:<iv>.<tag>.<data>`，AES-256-GCM，
   密钥是 `sha256("zcode-credential-fallback:<platform>:<home>:<user>")`，或
   `ZCODE_CREDENTIAL_SECRET`）。直接拿密文去请求会得到 401
   （"令牌已过期或验证不正确"）——**这是本插件第一版踩到的坑**。解不开、或解出来不像
   key（不含 `.`、含占位符）的账号被跳过。
3. **轮换**：请求先给池里没被判定为"额度耗尽"的账号；厂商回 429/402/401/403 时，
   换下一个账号重试同一个请求（请求体读一次、发多次）。厂商在 429 里会说额度何时重置，
   本插件记下那个时间，在重置前不再问这个账号。
4. **兜底**：池读不到时，退回登录时存下的那一把 key，仍可服务单账号。

## 已知边界

- **面板（P5）读不到本机文件**：magpie 的社区面板跑在 `sandbox allow-scripts` 的 iframe 里，
  `connect-src 'none'`，只能读 magpie 声明的接口（`usage:summary`、`providers:list`）和自己的
  options。所以本插件 v1 **不自带面板**，账号池的状态由 magpie 自己的 provider 卡片/额度卡显示。
- **不覆盖官方插件的登录流程**：这里只管"用哪个账号发请求"，不负责 OAuth 登录、
  团队席位、Start Plan 这些——那些仍由 `@magpie-community/opencode-zcode-auth` 负责。
  两个插件并存：`zcode/*` 是官方单账号，`zcode-pool/*` 是本机账号池。
- **账号池以 zcode-switcher 为准**：本插件只读不写它的目录。换账号、导入导出账号，
  仍在 zcode-switcher 里做。

## 与 zcode-switcher 的关系

- zcode-switcher：`halfking/zcode-switcher` —— ZCode 账号池的本机管理者（Tauri 桌面应用）
- 本插件：`halfking/magpie-zcode-pool` —— 把那个账号池接进 magpie 的网关
- magpie：`halfking/magpie` —— 网关与界面

## 许可

MIT。凭据的解密方式与模型清单参照了 `magpie-community/plugins` 的
`packages/zcode`（同为 MIT）。
