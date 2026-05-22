# TSB 実機テスト手順 (Blockbench + 手元 PC + Vanilla 1.20.4 server)

- **対象** : TSB Optimized Export バリアント (`tsb_optimized_export: true`) 全機能 (Phase B-0 〜 Phase B-1.5 priority-aware)
- **環境** : 手元 PC (Blockbench 5.1.4 + 改造 AJ プラグイン + Vanilla MC 1.20.4 server)
- **位置づけ** : Phase D 本検証の前哨戦として整備、 Phase D 完了後も AJ 改造に変更が入るたびのリグレッションテストとして再利用可能。 単 bp / 並列 / cleanup / リロード / priority-aware の挙動を実機で確認
- **関連 docs** :
  - 設計根拠 : `./tsb-known-issues/parallel-project-load.md` (リポジトリ内)
  - 文字列レベル検証 : `~/docs-workspace/animated-java/tsb-phase-b1-verification.md` (EC2 オリエンテーション資料)
  - 出力サンプル : `~/docs-workspace/animated-java/tsb-output-sample.md` (EC2 オリエンテーション資料)
  - 上位仕様 : `~/docs-workspace/next-tasks/animated-java-optimization.md` (EC2 正本仕様書)

## 0. 想定読者と進め方

イーラ君が手元 PC で順次実行する想定。 EC2 側でビルドした AJ プラグイン (`dist/animated_java.js`) を取得済みで、 アキシャ blueprint (`~/aj-workspace/blueprint/axia.ajblueprint`) も持ち出し済みの状態から始まる。 セットアップ手順は [[aj-local-dev-setup]] を参照。

各テストは独立して動かせるように設計。 つまづいたら該当テストだけ再実行可能。

## 1. 前提環境

### 必須ソフトウェア

- [ ] Blockbench 5.1.4 (5.0+ なら可だが 5.1.4 で動作確認済)
- [ ] 改造 AJ プラグイン (`dist/animated_java.js`、 EC2 の `~/aj-workspace/repos/animated-java/dist/` から取得)
- [ ] Vanilla Minecraft 1.20.4 server (`server.jar`、 公式から取得)
- [ ] Java 17+ (server 実行用)
- [ ] アキシャ blueprint (`axia.ajblueprint`)、 もしくはアキシャから派生した 2 つ目の blueprint (並列 load 検証用)

### server 設定 (`server.properties`)

- [ ] `gamemode=creative`
- [ ] `op-permission-level=4` (cheat 利用のため)
- [ ] `enable-command-block=true`
- [ ] `level-type=minecraft:flat` (検証用、 ロード負荷を最小化)
- [ ] `max-tick-time=-1` (TPS 計測中に server kick されないように)

### 推奨ツール

- [ ] `screen` / `tmux` (server をバックグラウンド実行 + ログ tail 用)
- [ ] テキストエディタ (生成された mcfunction を確認 + 手動編集用)

## 2. 準備フロー

### 2-1. AJ プラグインのインストール

1. Blockbench を起動
2. メニュー : File → Plugins → Load Plugin from File → `dist/animated_java.js` を選択
3. プラグイン一覧に「Animated Java」 が表示されること

### 2-2. アキシャ blueprint を開く

1. メニュー : File → Open → `axia.ajblueprint` を選択
2. アキシャの 3D モデルとアニメーション一覧が表示されること
3. 警告 / エラーが出たら DFU パスの問題、 [[aj-base-version]] を参照

### 2-3. TSB Optimized Export を有効化

1. メニュー : Animated Java → Blueprint Settings → TSB ページ
2. 「TSB Optimized Export」 チェックボックスを **ON**
3. 残りの TSB フラグはデフォルト :
   - Quantization Digits : `5`
   - Cells Per Tick : `1000`
   - Max Line Bytes : `1000000`
   - Silent Uninstall : `true` (チェック ON)
4. OK で閉じる
5. 同時に Project Settings で `Blueprint ID` が `aj:axia` 等になっていることを確認

### 2-4. datapack export

1. メニュー : Animated Java → Export Datapack
2. 出力先 : 一時ディレクトリ (例 : `~/Desktop/aj-test-pack/`、 datapack folder としてそのまま使える形)
3. 完了後、 出力先のツリーが `tsb-output-sample.md` のツリー構造と一致すること (大枠)

### 2-5. server へ datapack 配置

1. server の `world/datapacks/` 配下に `aj-test-pack/` ごとコピー
2. server を起動 (またはコンソールで `/reload`)
3. server ログに「Reloading datapacks...」 → エラーなく完了すること

## 3. テスト 1 : 単 blueprint export + 出力ファイル構造検証

実機 reload の前に、 まず生成された mcfunction が想定通りかをファイルシステム上で確認。

### 検証手順

```bash
# 出力ディレクトリに移動
cd ~/Desktop/aj-test-pack/data/aj/functions/axia/

# ツリー確認
tree .  # tree が無ければ find . -type f
```

### 期待されるファイル群

- [ ] `_bone_id_mapping.mcfunction`
- [ ] `cleanup.mcfunction`
- [ ] `expand/<anim>/p<N>.mcfunction` (アキシャ 21 アニメ × 各 1〜数バッチ)
- [ ] `expand_variants.mcfunction` (**project 単位 1 ファイル**、 variant 持ち anim が 1 つでもあれば生成。 旧 `expand_variants/<anim>.mcfunction` ディレクトリ構成は廃止)
- [ ] `force_load/<anim>.mcfunction` (全 anim、 **冒頭に variant guard 行が含まれる**)
- [ ] `load/init_queue.mcfunction`
- [ ] `load/dispatch.mcfunction`
- [ ] `load/step/{immediate,high,low}.mcfunction` (3 ファイル)
- [ ] `load/rotate_active/{immediate,high,low}.mcfunction` (3 ファイル)
- [ ] `load/remove_from_priority/{immediate,high,low}.mcfunction` (3 ファイル)
- [ ] `load/pop/{immediate,high,low}.mcfunction` (3 ファイル)

旧形式が **出力されていない** こと :

- [ ] `load/tick.mcfunction` が無い
- [ ] `load/step.mcfunction` (単一) が無い
- [ ] `load/rotate_active.mcfunction` (単一) が無い
- [ ] `load/remove_from_global.mcfunction` が無い

### global 関数 + tag json

```bash
cd ~/Desktop/aj-test-pack/data/animated_java/functions/global/
ls -la load_tick.mcfunction load_dispatch_step/
cat ~/Desktop/aj-test-pack/data/minecraft/tags/functions/tick.json
```

- [ ] `load_tick.mcfunction` が存在
- [ ] `load_dispatch_step/{immediate,high,low}.mcfunction` (3 ファイル)
- [ ] `tick.json` の `values` array に `"animated_java:global/load_tick"` が含まれる

### 各ファイル中身のスポットチェック

`tsb-phase-b1-verification.md` の「3-5. 各ファイル中身の検証」 セクションを参照。 ここでは Phase B-1.5 で追加されたファイルだけ確認 :

```bash
# init_queue : 該当 priority のみ global 登録 + has_work set
cat load/init_queue.mcfunction
```

期待 :
- 3 priority 別の `data modify storage aj.axia:state d.queue.<pri> set value [...]` :
  - `queue.immediate` に **variant ref 1 個** : `["aj:axia/expand_variants"]` (variant が 1 つでもあれば、 自動で immediate 固定)
  - `queue.high` は空
  - `queue.low` に **全 anim の bone expand 参照リスト** (Phase B-1 暫定で全アニメ low 固定、 Phase B-1.6 UI 拡張で振り分け可能になる予定)
- `execute unless data storage aj.global:state d.active."aj:axia".immediate ... append value {id:"aj:axia"}`
- `data modify storage aj.global:state d.active."aj:axia".immediate set value 1b`
- `execute unless data storage aj.global:state d.active."aj:axia".low ... append value {id:"aj:axia"}`
- `data modify storage aj.global:state d.active."aj:axia".low set value 1b`
- `data modify storage aj.global:state d.has_work set value 1b`
- `schedule function` 行 **無し**

```bash
# variant 集約後の expand_variants.mcfunction
cat expand_variants.mcfunction
```

期待 (variant 持ち anim が N 個ある場合) :
- N 行 + 1 行 = `$data modify storage aj.axia:variants d.<anim>$(_) set value {...}` を N 行 (anim 単位の compound は維持) + 末尾に `$data modify storage aj.axia:state d.loaded_variants$(_) set value 1b` (**project 単位 boolean** に縮約済み)
- 旧形式 (`d.loaded_variants.<anim>$(_) set value 1b`) **無し**

```bash
# force_load 同期経路 (variant guard が冒頭にあること)
cat force_load/<anim>.mcfunction
```

期待 :
- 1 行目 : `execute unless data storage aj.axia:state d.loaded_variants run function aj:axia/expand_variants {_: ""}` (variant 未ロード時のみ project 全 variant 同期展開)
- 2 行目以降 : `function aj:axia/expand/<anim>/p<N> {_: ""}` を該当 anim のバッチ数分

```bash
cat load/step/low.mcfunction
```

期待 (3 行) :
```
function aj:axia/load/pop/low
execute if data storage aj.axia:state d.queue.low[0] run return run function aj:axia/load/rotate_active/low
function aj:axia/load/remove_from_priority/low
```

## 4. テスト 2 : reload → 単 bp 段階展開動作確認

アキシャを実機 reload して、 段階展開が動くことを確認。

### 4-1. reload 前のクリーン状態確保

```mcfunction
# server console or in-game OP chat
data remove storage aj.axia:state d
data remove storage aj.global:state d
```

(初回 reload なら storage 空、 不要)

### 4-2. reload + 直後の storage 状態確認

```mcfunction
/reload
```

reload 直後 (1 tick 以内、 まだ load_tick が走る前) :

```mcfunction
/data get storage aj.global:state d
```

期待される storage (例、 variant 持ち anim が 1 つ以上ある場合) :
```
{has_work: 1b, active: {"aj:axia": {immediate: 1b, low: 1b}}, queue_order: {immediate: [{id: "aj:axia"}], low: [{id: "aj:axia"}]}}
```

- [ ] `has_work: 1b` が立っている
- [ ] `active."aj:axia".immediate: 1b` + `active."aj:axia".low: 1b` (high は無い)
- [ ] `queue_order.immediate = [{id: "aj:axia"}]` (variant 用)
- [ ] `queue_order.low = [{id: "aj:axia"}]` (bone expand 用)
- [ ] `queue_order.high` が **存在しない**

variant を持つ anim が無い blueprint なら `queue_order.immediate` も無し。

```mcfunction
/data get storage aj.axia:state d.queue
```

期待 :
- [ ] `queue.immediate = ["aj:axia/expand_variants"]` (variant ref 1 個固定、 variant が無い blueprint なら `[]`)
- [ ] `queue.high = []`
- [ ] `queue.low` に **全 anim の bone expand 参照リスト**

### 4-3. 段階展開ペース観察

server tick を 1 tick ずつ進める方法は無いので、 「観察ポイント」 を絞る :

```mcfunction
# 5 tick 後 (= 1/4 秒後) に状態を確認
/execute schedule function aj:axia/_debug_dump 5t
```

`_debug_dump.mcfunction` を一時的に手動配置 :

```mcfunction
# data/aj/functions/axia/_debug_dump.mcfunction (手動配置)
tellraw @a {"text":"--- aj.global:state ---","color":"yellow"}
data get storage aj.global:state d.has_work
data get storage aj.global:state d.queue_order.low
tellraw @a {"text":"--- aj.axia:state d.queue.low size ---","color":"yellow"}
data get storage aj.axia:state d.queue.low
```

確認項目 :
- [ ] **1 tick 目** : `queue.immediate` が **空になっている** (variant ref 1 個が即 flush されて pop 済み)、 `d.loaded_variants = 1b` が立っている
- [ ] `queue_order.immediate` が **削除されている** (variant ロード完了で remove_from_priority 経路で pop)
- [ ] `queue.low` のリスト長が 5 tick で約 5 件減っている (1 expand /tick で消化、 immediate 消費後は low に集中)
- [ ] `has_work` が 1b のまま (まだ low に work 残っている)
- [ ] `queue_order.low` は `[{id: "aj:axia"}]` のまま (1 bp しか居ないので round-robin しても変わらない)

### 4-4. 段階展開完了の検出

アキシャは 43200 cells / cells_per_tick=1000 = 43 バッチ → 43 tick で展開完了見込み。
expand 関数 1 個あたり 1 tick 消費。 アキシャ全 anim の expand 関数数を N とすると約 N tick で完走。

完走後 (例 : reload から 60 tick = 3 秒後) :

```mcfunction
/data get storage aj.global:state d
```

期待 :
- [ ] `has_work` キー自体が **存在しない** (load_tick はアイドルガードで return)
- [ ] `active` 空 (or 削除済み)
- [ ] `queue_order` 全 priority 空

```mcfunction
/data get storage aj.axia:state d.loaded
```

期待 :
- [ ] 全 anim の completion mark `<anim>: 1b` が並ぶ (= 全アニメ展開完了の証拠)

### 4-5. ロード完了後の常駐コスト確認

完走後にしばらく放置 (1 分程度) して、 TPS / MSPT が落ちていないこと :

```mcfunction
/forceload add 0 0
# in-game F3 で MSPT 表示確認
```

- [ ] MSPT が誤差レベル (load 中と比べて load 後の方が明らかに軽い、 has_work アイドルガードが効いている証拠)
- [ ] `tick` プロファイラ : `/debug start` → 1 分後 `/debug stop` で生成されるレポートで、 `animated_java:global/load_tick` が **ほぼゼロコスト** で並んでいること

## 5. テスト 3 : cleanup 動作確認

### 5-1. silent uninstall=true (default) で手動 cleanup

```mcfunction
/function aj:axia/cleanup
```

確認 :
- [ ] tellraw が **出ない** (UNINSTALL メッセージ抑制)
- [ ] `data get storage aj.axia:anim d` → 何も出ない (削除済み)
- [ ] `data get storage aj.axia:variants d` → 何も出ない
- [ ] `data get storage aj.axia:state d` → 何も出ない
- [ ] `data get storage aj.global:state d` → `has_work` 含めて何も出ない (= 完全 idle に戻った)
- [ ] `scoreboard objectives list` で `aj.<anim>.frame` 系が全て消えていること、 ただし global (`aj.i` / `aj.id` / `aj.is_rig_loaded` / `aj.tween_duration`) は残っていること

### 5-2. silent uninstall=false で手動 cleanup

1. Blockbench に戻って Blueprint Settings → TSB ページ → 「Silent Uninstall」 を **OFF**
2. 再 export → server の datapack 上書き → `/reload`
3. 再度ロード完走を待つ
4. `/function aj:axia/cleanup`

確認 :
- [ ] tellraw `Successfully uninstalled axia!` が **出る**
- [ ] tellraw の **構文エラーが server log に出ない** (`Couldn't parse text component` などが出ないこと)
- [ ] tellraw 行が JSON 形式 (`"color":"red"` / `"color":"green"` 形式、 SNBT (`"color":red`) ではない) で出力されていることを `cat data/animated_java/functions/axia/remove_animation_objectives.mcfunction` で確認 (tellraw-snbt-on-1.20.4 修正の検証ポイント)

### 5-3. cleanup 後の reload で正常復帰

```mcfunction
/reload
```

- [ ] reload 直後の storage 状態がテスト 4-2 と同じ (= cleanup → reload で正常な初期状態)
- [ ] load_tick が再起動して段階展開が再開する

## 6. テスト 4 : 並列 load (2 bp 同時 reload)

priority-aware global round-robin の動作確認。

### 6-1. 2 つ目の blueprint を用意

アキシャの blueprint をベースに、 Blueprint ID と 1 アニメだけ書き換えた簡易バージョンを作る :

1. Blockbench で `axia.ajblueprint` を別名保存 (`axia_clone.ajblueprint`)
2. Project Settings で Blueprint ID を `aj:axia_clone` に変更
3. アニメ一覧から 1 つだけ残して他を削除 (検証時間短縮)
4. TSB Optimized Export ON (default 設定維持)
5. Export → server の `world/datapacks/` に `axia-clone-pack/` として配置

### 6-2. 2 つ同時に reload

```mcfunction
# 両方の datapack が有効化された状態で
/reload
```

reload 直後 :

```mcfunction
/data get storage aj.global:state d
```

期待 :
- [ ] `has_work: 1b`
- [ ] `active = {"aj:axia": {low: 1b}, "aj:axia_clone": {low: 1b}}`
- [ ] `queue_order.low = [{id: "aj:axia"}, {id: "aj:axia_clone"}]` または順序逆 (登録順は datapack load 順で決まる)

### 6-3. round-robin 動作確認

ロード進行中 (10〜20 tick 後) に `queue_order.low` を観察 :

```mcfunction
/data get storage aj.global:state d.queue_order.low
```

- [ ] リスト要素は常に 2 つ存在 (両方が完走するまで)
- [ ] 先頭エントリが交互に入れ替わっている (round-robin)
- [ ] `aj.axia:state d.queue.low` と `aj.axia_clone:state d.queue.low` の両方が同じペースで減っている (= 公平)

### 6-4. 片方完走後の挙動

`axia_clone` の方が早く完走する (アニメ数が少ないため) :

```mcfunction
/data get storage aj.axia_clone:state d.loaded
```

- [ ] axia_clone のアニメすべてに `1b` (完走)
- [ ] `aj.global:state d.queue_order.low = [{id: "aj:axia"}]` (axia_clone は削除された、 axia のみ残)
- [ ] `aj.global:state d.active."aj:axia_clone"` キーが存在しない (= remove_from_priority で削除済み)
- [ ] `has_work: 1b` のまま (axia がまだ work 残)

axia 完走後 :

- [ ] `queue_order.low` 自体が空 (or 削除済み)
- [ ] `has_work` キー自体が存在しない (= 完全 idle)

## 7. テスト 5 : priority-aware の振る舞い (手動 immediate 注入)

AJ 本体は priority UI が未実装で全アニメが low に積まれるため、 immediate / high の挙動は手動注入で検証する。

### 7-1. アキシャ単体で reload + ロード途中で immediate 注入

```mcfunction
/reload
# ロード途中 (= queue.low にまだ残量あり) で、 immediate に 1 件手動注入
/data modify storage aj.axia:state d.queue.immediate set value ["aj:axia/expand/idle/p0"]
/execute unless data storage aj.global:state d.active."aj:axia".immediate run data modify storage aj.global:state d.queue_order.immediate append value {id:"aj:axia"}
/data modify storage aj.global:state d.active."aj:axia".immediate set value 1b
```

期待される挙動 :
- [ ] 次 tick の load_tick が `queue_order.immediate[0]` で hit → `load_dispatch_step/immediate` → `aj:axia/load/step/immediate` を呼ぶ
- [ ] axia.queue.immediate が 1 件 pop されて空に
- [ ] `remove_from_priority/immediate` が走り、 `active."aj:axia".immediate` 削除 + `queue_order.immediate` 空
- [ ] その後 low の処理が再開 (= immediate を割り込ませた分だけ low が遅延)

確認コマンド :

```mcfunction
# immediate 注入直後
/data get storage aj.global:state d.queue_order
# → {immediate: [{id:"aj:axia"}], low: [{id:"aj:axia"}]}

# 1 tick 後
/data get storage aj.global:state d.queue_order
# → {low: [{id:"aj:axia"}]}  (immediate は完走 + 削除済み)
```

### 7-2. 2 bp 同時 active + 片方に immediate 注入

axia と axia_clone が両方 load 中の状態で、 axia_clone のみに immediate 注入 :

```mcfunction
# axia_clone.queue.immediate に 1 件注入
/data modify storage aj.axia_clone:state d.queue.immediate set value ["aj:axia_clone/expand/<some_anim>/p0"]
/execute unless data storage aj.global:state d.active."aj:axia_clone".immediate run data modify storage aj.global:state d.queue_order.immediate append value {id:"aj:axia_clone"}
/data modify storage aj.global:state d.active."aj:axia_clone".immediate set value 1b
```

期待 :
- [ ] 次 tick で `queue_order.immediate[0] = {axia_clone}` が hit → axia_clone の immediate が先に処理される
- [ ] axia の low はその間 1 tick だけ待たされる (= priority 順序保証)
- [ ] axia_clone.immediate 完走後、 通常通り axia と axia_clone の low が round-robin 再開

## 8. テスト 6 : load 中 reload (削除アニメパターン含む)

リロード時の旧 queue 残骸 / 削除アニメ参照混入の検証。

### 8-1. load 中 reload (アニメ削除なし)

```mcfunction
/reload                              # 初回 reload、 load 開始
# 5 tick 後 (まだ load 中) に再度 reload
/reload                              # 2 回目 reload
```

期待 :
- [ ] 2 回目 reload 後、 `queue.low` が **set value で完全上書き** (旧残量は破棄)
- [ ] `queue_order.low` は重複 append されない (= 1 エントリのまま、 `unless` ガードが効いている)
- [ ] `has_work` は冪等な set value で再立ち
- [ ] エラーログなし

### 8-2. load 中 reload (削除アニメパターン)

```mcfunction
/reload                              # 初回 reload、 load 開始
```

Blockbench で axia から 1 アニメを削除 → re-export → server の datapack 上書き → 再度 reload :

```mcfunction
/reload                              # 削除アニメを含む新版で再 reload
```

期待 :
- [ ] 2 回目 reload 後の `queue.low` に **削除されたアニメへの expand 参照が含まれない** (= 新 init_queue で完全上書き、 旧キューの該当エントリは破棄)
- [ ] サーバログに `Unknown function aj:axia/expand/<deleted_anim>/p0` 等のエラー **出ない**
- [ ] 新版にあるアニメは正常に展開完了

### 8-3. アニメ削除 + cleanup 経由 reload (推奨パス)

ベストプラクティス手順の確認 :

```mcfunction
/function aj:axia/cleanup           # アニメ削除 前 に cleanup
# (この時点で storage は完全クリア)
/reload                              # 削除アニメを含む新版を反映
```

- [ ] cleanup 後の `aj.global:state` が完全空
- [ ] reload 後の挙動が「初回 reload」 と完全に等価

## 9. 検査用コマンド集 (定型テンプレ)

```mcfunction
# global 状態スナップショット
/data get storage aj.global:state d

# 個別 bp の queue 残量
/data get storage aj.axia:state d.queue

# 個別 bp の loaded フラグ
/data get storage aj.axia:state d.loaded

# variant 完了フラグ (project 単位 boolean、 1b なら全 variant ロード済み)
/data get storage aj.axia:state d.loaded_variants

# tick.json タグ登録確認 (server コンソール)
/function animated_java:global/load_tick   # 単発で呼んでもエラーなく終了すること

# scoreboard objective 一覧
/scoreboard objectives list

# strict プロファイリング
/debug start
# (60 秒待つ)
/debug stop
# → world/debug/ 配下の profile-result-*.txt を解析
```

## 10. トラブルシューティング

### 10-1. reload 時に server がフリーズ / クラッシュ

原因候補 :
- TagParser に重い NBT が渡されている (= 改造が効いていない、 旧 `data modify ... merge value {巨大 NBT}` が残っている)

確認 :
```bash
# 出力された on_load.mcfunction を確認
cat data/animated_java/functions/axia/on_load.mcfunction | wc -l
```

- [ ] 純正 AJ の on_load は 41 行 + 6.8MB だが、 TSB 改造後は **数行 + 数 KB** で済むはず。 もし大きいまま → `tsb_optimized_export` フラグが OFF になっている、 もしくは AJ プラグインが古い

### 10-2. 段階展開が進まない (queue が減らない)

確認 :
```mcfunction
/data get storage aj.global:state d.has_work
```

- [ ] `1b` が立っているか → 立っていないなら init_queue で has_work set 行が走っていない (= 該当 priority 全部空判定された)
- [ ] `queue_order.<pri>` に自 bp が居るか → 居なければ register 行が走っていない
- [ ] `function animated_java:global/load_tick` を手動実行 → 単発で正常終了するか

### 10-3. cleanup 後 reload で load が再開しない

- [ ] cleanup が完全に走ったか確認 (`aj.global:state` 完全空)
- [ ] `/reload` 後の init_queue が走ったか確認 (`aj.axia:state d.queue.low` が再 set されているか)

### 10-4. 2 bp 同時 load で TPS が崩れる

- [ ] `/debug start` でプロファイル取得、 1 tick あたりの expand 関数実行コストを確認
- [ ] `cells_per_tick` を下げる (Blueprint Settings TSB ページ、 default 1000 → 500 等)
- [ ] 同時 reload を避け、 順次 reload する運用に切り替え

### 10-5. 削除アニメへの参照エラーが出る

- [ ] 改造ロジックの bug の可能性、 `./tsb-known-issues/parallel-project-load.md` の「リロード時の挙動」 セクションを再確認
- [ ] EC2 に戻って `git log -- src/systems/datapackCompiler/createAnimationStorageTsb.ts` で改造状態を確認

## 11. 完了基準 (= Phase D 本検証に進める判断基準)

- [ ] テスト 1 〜 6 のすべてのチェック項目が PASS
- [ ] 段階展開中に MSPT が許容範囲 (cells_per_tick = 1000 で MSPT < 50ms 維持)
- [ ] ロード完了後の常駐コストが MSPT < 1ms (= has_work アイドルガードが効いている)
- [ ] 2 bp 同時 load でも全体 budget が 1 expand /tick に収まる (= MSPT が単 bp と同等)
- [ ] cleanup → reload サイクルで残骸 / 不整合が発生しない
- [ ] サーバログにエラー (`Unknown function` / `Couldn't load functions` / `Couldn't parse text component` 等) が出ない
- [ ] **tellraw 関連** : 1.20.4 で `"color":"red"` などの JSON 形式で出力されている (SNBT (`"color":red`) になっていない、 `tellraw-snbt-on-1.20.4` 修正の検証)
- [ ] **variant 関連** : `expand_variants.mcfunction` が project 単位 1 ファイル、 `force_load/<anim>.mcfunction` 冒頭に variant guard 行、 `init_queue` の `queue.immediate` に variant ref 1 個固定、 `d.loaded_variants` が project 単位 boolean

## 12. 検証結果のフィードバック (次セッション引き継ぎ用)

### 12-1. 結果報告テンプレート

検証が終わったら、 以下のテンプレートを埋めて次セッションのラヴィに渡す
(チャット冒頭に貼り付け or `~/docs-workspace/animated-java/tsb-phase-d-results.md` を新規作成して中身を保存)。

```markdown
# TSB 実機テスト結果 (YYYY-MM-DD)

## 環境
- Blockbench バージョン : 5.1.4
- MC server : Vanilla 1.20.4
- AJ プラグイン HEAD : <SHA、 例 f5378f3>
- 検証 blueprint : axia (+ axia_clone)
- TSB 設定 : Quantization=5, CellsPerTick=1000, MaxLineBytes=1000000, SilentUninstall=true

## 結果サマリ

| テスト | 結果 | MSPT (load 中 / アイドル) | 備考 |
|---|---|---|---|
| 1. 出力ファイル構造 | PASS / FAIL |  |  |
| 2. 単 bp 段階展開 | PASS / FAIL | <ms> / <ms> |  |
| 3. cleanup 動作 | PASS / FAIL |  | silent true/false 両方 |
| 4. 並列 load (2 bp 同時) | PASS / FAIL | <ms> / <ms> |  |
| 5. priority-aware 手動注入 | PASS / FAIL |  | 単 bp + 2 bp |
| 6. load 中 reload | PASS / FAIL |  | 削除アニメパターン含む |

## FAIL 詳細 (該当時)

### テスト N
- 期待 : <docs に書いた期待挙動>
- 実際 : <観察したこと>
- ログ抜粋 : <server log の該当行、 もしくは /data get の出力>
- 推測される原因カテゴリ : 設計バグ / 環境依存 / 改造未追従

## 次セッションで進めて欲しい対応

- [ ] FAIL 修正 (具体的なテスト番号 + 原因カテゴリ)
- [ ] 完全 PASS なら Phase B-1.6 (UI 拡張) or Phase C (再生側) のどちらに進む

## その他気付き

(MSPT のチューニング余地、 想定外の挙動、 docs の説明不足箇所 等)
```

### 12-2. FAIL ケース → 修正対象ファイルのマッピング

FAIL 報告を受けたとき、 次セッションのラヴィが最初に当たる場所 :

| FAIL の症状 | 一次調査ファイル | 関連 docs |
|---|---|---|
| ファイル不在 / 余分なファイル (テスト 1) | `src/systems/datapackCompiler/createAnimationStorageTsb.ts` の file map ループ (`for (const pri of PRIORITIES) { files.set(...) }`) | `tsb-known-issues/parallel-project-load.md` |
| init_queue の出力ズレ (テスト 1 / 2) | `createAnimationStorageTsb.ts:buildInitQueue` | 同上 |
| 段階展開が進まない (テスト 2) | `1.20.4-tsb/global.mcb` の load_tick / load_dispatch_step、 `createAnimationStorageTsb.ts:buildLoadStep` | `tsb-known-issues/parallel-project-load.md` |
| has_work が立たない / 消えない (テスト 2 / 4) | `buildInitQueue` 末尾の has_work set、 `buildRemoveFromPriority` 末尾の全 priority 空判定 | 同上 |
| cleanup の残骸 (テスト 3) | `createAnimationStorageTsb.ts:buildCleanup` の 3 priority queue_order 削除 + has_work クリア | `tsb-known-issues/cleanup-on-load-removed.md` |
| silent uninstall が効かない (テスト 3) | `1.20.4-tsb/main.mcb` の `IF (!tsb_silent_uninstall)` 分岐、 Blueprint Settings | `tsb-known-issues/cleanup-on-load-removed.md` 第 3 段階 |
| round-robin が公平に回らない (テスト 4) | `createAnimationStorageTsb.ts:buildRotateActive` (`queue_order.<pri>[0]` 削除 + 末尾 append の 2 行) | `tsb-known-issues/parallel-project-load.md` |
| priority 順序が崩れる (テスト 5) | `1.20.4-tsb/global.mcb` の load_tick の 3 priority 判定順 (immediate → high → low の return run チェーン) | 同上 |
| 削除アニメ参照エラー (テスト 6) | `buildInitQueue` の queue 上書き (= set value、 削除アニメ参照が新値に置き換わる前提)、 もしくは旧 queue が `data modify append` で残るバグ | 同上の「リロード時の挙動」 |
| TPS 崩れ (テスト 4 / 全体) | `cells_per_tick` Blueprint Setting の調整 + プロファイル取得 (`/debug start`) | `~/docs-workspace/next-tasks/animated-java-optimization.md` の A-5 セクション |
| tellraw `"color":red` で SNBT 構文エラー (テスト 3 / 全体) | `src/systems/datapackCompiler/tellraw.ts` の `renderTextComponent` ヘルパー経由化 | `tsb-known-issues/tellraw-snbt-on-1.20.4.md` |
| variant 集約不整合 (`expand_variants/<anim>.mcfunction` が残る or `loaded_variants.<anim>` が立つ) (テスト 1) | `createAnimationStorageTsb.ts:buildProjectVariantsExpand` + メインループの variant 単一 ref 処理 | 本ファイル § 3-3 / § 4-2 |
| force_load で variant 同期されない (テスト 2 / 6) | `createAnimationStorageTsb.ts:buildForceLoad` の variant guard 行追加 | 同上 |
| variant が immediate priority に入らない (テスト 1 / 2) | `createAnimationStorageTsb.ts:buildInitQueue` の `buckets.immediate.push(variantsExpandRef)` 部分 | 同上 |

### 12-3. FAIL 分類別の対応方針

- **(a) 設計バグ** : 該当ファイル + テストケースを改修 → vitest 通過確認 → prod build 0 errors → commit + push
- **(b) 環境依存** : 検証手順 (このファイル) に注記追加、 もしくはトラブルシューティング (§ 10) に新規ケース追加
- **(c) AJ 本体改造で追従が必要** : Phase B-1.6 / Phase B-2 / Phase C のスコープに組み込む、 `~/docs-workspace/next-tasks/animated-java-optimization.md` の Phase 進捗表に追記

## 関連ドキュメント

- 設計根拠 : `./tsb-known-issues/parallel-project-load.md` (リポジトリ内)
- 文字列レベル検証 : `~/docs-workspace/animated-java/tsb-phase-b1-verification.md`
- 出力サンプル : `~/docs-workspace/animated-java/tsb-output-sample.md`
- 上位仕様 : `~/docs-workspace/next-tasks/animated-java-optimization.md`
- 手元 PC 環境構築 : メモリ [[aj-local-dev-setup]]
- AJ base version : メモリ [[aj-base-version]]
