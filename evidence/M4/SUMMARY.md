# M4 SUMMARY — 搗蛋鬼（版本 A）

- 日期：2026-11-16｜部署：`192.168.99.20:30005`（最新 build）
- 證據：`test.log`（本機 9/9＋部署機 9/9）、`deploy.log`（重啟前後 saboteurState／28 筆揪中 +3／1 筆 +5／revision 113 一致）、`api.log`（stage 冇 secretRole 洩漏、role-reveal 公開身份、host 全場身份）

## 做咗乜（§4）
- `saboteur.assign`：隨機／指定（測試用 `saboteurIndex`）派 1 搗蛋鬼＋N 好人；只用 `player.setRole` 落 journal，**只送本人**（PlayerSelfView `roleInfo`）；stage 永不見 `secretRole`
- `saboteur.openRound`：建立 players vote 卡＋round（eligible＝approved 減已淘汰）
- `saboteur.closeRound`：計票（validVotes＝confirmed 非棄權）；唯一最高且 ≥ ⌊valid/2⌋+1 → 即場淘汰；未過半／平票 → 主持裁決（`retry`／`eliminate`）；全體棄權 → 當輪冇人淘汰
- 重投＝新 round（`retryOf` 指原 round、原 round void、原票保留唔計分、每輪最多一次）
- 揪中：搗蛋鬼被淘汰 → 公開 `revealedRole`＋同 transaction 每位投中者 +3、搗蛋鬼冇 +5、自動切 `role-reveal`；兩輪揪唔中 → 搗蛋鬼 +5
- 投票邊界：唔可以投自己（`W_SELF_VOTE`）；已淘汰者唔可以投（`W_FORBIDDEN_ROLE`）／唔可以被投；開票前 stage 只出進度、冇個人票／票數；host 台可見逐人票（host-only view）

## 驗收（本機 9/9、部署 9/9）
| # | 項目 | 結果 | 證據 |
|---|---|---|---|
| ① | 身份只送本人（stage／HTTP／WS sniffer） | **過** | stage snapshot 冇 secretRole／saboteurId；搗蛋鬼只自己見；其他人 crew |
| ② | 開票前 stage 只出投票進度、冇個人票 | **過** | mode=vote、counts 全 0、冇個人票 |
| ③ | 兩輪劇本（含刻意平票）＋主持裁決計分 | **過** | 平票→`decide`、重投新 round（retryOf）＋第二次重投 `W_ALREADY_STATE` |
| ④ | 投自己被拒 `W_SELF_VOTE` | **過** | submit.result rejected W_SELF_VOTE |
| ⑤ | 第一輪被淘汰者第二輪唔投／唔被投、保留分數 | **過** | 淘汰者投票 → `W_FORBIDDEN_ROLE`；eligible 29 人 |
| ⑥ | 揪中每位投票者 +3、搗蛋鬼冇 +5；兩輪揪唔中 +5 | **過** | 揪中 28 筆 +3（28 位在線非自投者）、冇 +5；兩輪完結 +5（finished=true caught=false） |
| ⑦ | 重連唔漏身份；重開唔重複派分 | **過** | 重連 roleInfo=crew；round 綁 roundId／submissionId 去重 |

## 遺留
- 主持「全場身份」視圖係 host 台列表（UI 可用）；未做逐人放大動畫（唔屬驗收）。
- 平票／未過半裁決流程 server 已有結果 payload（mode、top 名單）；host UI 顯示「裁決／重投」掣＋target select。

## 5. M2-M4 review 後 P1（2026-11-16 最終一輪；已清）

- **stage 開票後出 aggregate 票數＋淘汰名單**：`buildStageView` 加 `saboteurInfo`（淘汰名單／validVotes／top）＋ tally 在 closed/tally 後按 approved 玩家列 aggregate counts（**永遠唔出個人票**，voters=[]）；stage.ts tally/vote 顯示「已淘汰」名單。Test：M4 10/10，新增「開票後 options=30、countsSum=29、voters=0、eliminated 含被淘汰者」。
- **唔再改 live state 先過 journal**：`saboteur.openRound/closeRound/decide/finish` 全部 `cloneSaboteur()` 深 copy → 改 clone → `game.set` mutation → `store.commit()` fsync 成功後先生效；commit 拋錯（ENOSPC）唔會留下 memory／journal 不一致。
- **移除 `player.update {connected:false}` 淘汰標記**：淘汰一律以 `saboteurState.eliminatedIds` 為準，presence 由 hub 管。
- 本機 M4 10/10；deploy 後最終房 room 3840 restart 前後 scores 不變（M5/deploy.log）。檢查器 final audit 會覆核真機項。
