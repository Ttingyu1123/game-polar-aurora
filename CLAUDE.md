# POLAR AURORA — 專案守則

線上：https://game-polar-aurora.tingyudeco.com/ ・攻略 `/guide.html`
Repo：https://github.com/Ttingyu1123/game-polar-aurora （public）
架構與設計說明的正本是 **README.md**，本檔只寫「改動這個 repo 時必須知道的事」。

## 鐵則

1. **零素材**：不准引入任何圖片、音效檔、字型、框架、函式庫。所有視覺 = Canvas 程式繪製，所有聲音 = Web Audio 合成。連 PWA icon 都是 `tests/gen-icons.js` 畫的。
2. **classic script，非 ES module**：必須能從 `file://` 雙擊直開（Chrome 對 file:// + module 有 CORS 限制）。
3. **公平性寫在資料層**：任何降低可讀性的改動（天氣、視距、速度）必須付出 thinkMul／間距補償。`Biomes.js` 的 `think` 欄位與 `ObstacleManager._emit()` 的可解性閘門是底線，改渲染不准繞過。
4. **每日挑戰的決定論**：生成路徑上的隨機必須走 `this.rng`（可注種子），間距預算必須用 `paceAt()` 解析曲線、不准用受幀率影響的阻尼速度。動到生成器後跑 `features.js` 的 daily 測試驗證兩次開局逐字節相同。
5. **改動 = 部署後要 bump `sw.js` 的 `VERSION`**，否則舊玩家吃快取。

## 驗證（改完必跑，位於 tests/，先 `npm install`）

| 指令 | 驗什麼 | 通過線 |
|---|---|---|
| `node tests/qa.js` | 功能回歸（51 項） | 51/51 |
| `node tests/features.js` | meta-game（經濟/衣櫃/任務/復活/每日/生態/movers） | 21/21 |
| `node tests/fairness.js` | 0 重疊、0 無解、思考時間、閘門活性探測 | PASS |
| `node tests/playable.js` | 人類延遲機器人試玩 | 16/16 到 1500m |
| `node tests/audio.js` | AnalyserNode 實測 RMS（不是「物件存在」） | 14/14 |
| `node tests/layout.js` | 360×640 → 3440×1440 三車道全在畫面內 | all OK |
| 部署後 `node tests/live2.js` | production 冒煙（含 SW 離線、每日、衣櫃） | 9/9 |

量效能用 **rAF wall time**（Canvas2D 光柵化在別的執行緒，JS 計時器看不見真實成本）；找熱點用 ablation（逐一停用子系統量差值），不要只信 JS profiler。

## 調難度的旋鈕（單一數字）

- 速度：`Game.js` 的 `SPEED_MIN` / `RAMP_M`（曲線 = 1−e^(−d/RAMP)）
- 思考時間：`ObstacleManager.js` 的 `think` lerp（目前 1.9s→1.15s）
- 復活價：`Game.js` `REVIVE_COST`；任務成長：`Progress.js` `GROW`
- 改完必跑 fairness + playable，數字說話，不憑手感

## 已知陷阱（詳見 Obsidian 踩坑記錄）

- `Player.reset()` 必須把自己的 FSM 推回 `run`（轉圈企鵝事故）；任何「reset」都要問：狀態機本身重置了嗎
- 倒影/遮罩類效果不准在主 canvas 用 `destination-in`（會擦掉已畫好的世界），要開私有 buffer 合成
- 直向視窗 focal 要同時吃 width（`Camera.resize` 的 `min(h·1.02, w·1.45)`），只看 height 車道會掉出畫面
- 障礙的碰撞掃掠用各自的 `zPrev`（roller 有自身速度），不是全域 dz
- promo 影片：Playwright 不錄音 → 配樂用 `tests/render-music.js` 離線渲染遊戲同款合成配方再 ffmpeg 合成（本機 ffmpeg 無 libx264，用 `h264_nvenc`）

## 本機協作紀律

這台機器常有多個 session 併行。**commit 一律逐檔 `git add <path>`，絕不 `git add -A`**；push 前 `git status --short` 核對暫存區只有自己的檔案。`promo/`、`tests/node_modules/` 已 gitignore。
