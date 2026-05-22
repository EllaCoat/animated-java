# TSB Phase B-1.5: 並列 load の global キュー化

- **ステータス**: 方針確定 (案 A' 採用) → 実装中 (Phase B-1.5)
- **発見日**: 2026-05-22 (運用観点の懸念として提起)
- **方針確定日**: 2026-05-22 (同日、 MC ソース確認 + ちぇん氏改造版調査の結果を踏まえて)
- **重大度**: 中 → 解消方向 (複数 blueprint 同時 active で全体 budget = 1 × cells_per_tick に揃う)
- **影響箇所**: `src/systems/datapackCompiler/createAnimationStorageTsb.ts` / `src/systems/datapackCompiler/1.20.4-tsb/global.mcb`

## 問題の再掲

各 blueprint が独立に `schedule function aj:<bp>/load/tick 1t replace` で自己再 schedule する
構造のため、 N 個の blueprint が同時 active な状況では毎 tick で N 回の load/tick が走り、
**全体 budget が N × cells_per_tick に線形比例して膨らむ**。 開発時の同時 reload や、
今後プロジェクト数が増えた際に顕在化する。

## 採用方針: 案 A' (global active list + minecraft:tick タグ駆動 + per-bp queue + round-robin)

「キュー global 管理 + tag/tick.json で監視 + force_load は loaded フラグ判定」 という
イーラ君提案 (2026-05-22 メッセージ) を、 リロード安全性を考慮して per-bp 区切り + active
list 方式に展開した形。 ちぇん氏改造版が `animated_java:global/on_tick` を `minecraft:tick`
タグ経由で常駐させていた設計と整合的。

### 全体構造

```
┌─────────────────────────────────────────────────────────────────────────┐
│ aj.global:state  (TSB バリアントの新規 storage、 全 bp 共有)              │
│   d.active = {                                                          │
│     <bp_id_1>: 1b,   # membership set (重複登録ガード用)                  │
│     <bp_id_2>: 1b,                                                      │
│     ...                                                                 │
│   }                                                                     │
│   d.queue_order = [                                                     │
│     "<bp_id_1>", "<bp_id_2>", ...   # 巡回順序 (round-robin 用、 list)   │
│   ]                                                                     │
└─────────────────────────────────────────────────────────────────────────┘
            ▲ append (重複ガード)
            │                                  ▼ 先頭を読んで dispatch
┌──────────────────────┐   ┌──────────────────────────────────────────┐
│ aj:<bp>/load/init_queue│   │ animated_java:global/load_tick (minecraft:tick)│
│ ─ 自 bp queue を上書き│   │ ─ queue_order[0] が無ければ早期 return        │
│ ─ global active 登録 │   │ ─ ある場合 dispatch_step を呼ぶ                │
└──────────────────────┘   │ ─ dispatch_step が                              │
                           │     $function aj:$(queue_order[0])/load/step    │
                           └──────────────────────────────────────────┘
                                                  │
                                                  ▼
                              ┌──────────────────────────────────────────┐
                              │ aj:<bp>/load/step (per-bp)              │
                              │ ─ immediate→high→low の 1 pop + dispatch│
                              │ ─ 末尾で queue 残量を判定               │
                              │   ─ 残ってる→rotate_active (round-robin)│
                              │   ─ 空 → remove_from_global             │
                              └──────────────────────────────────────────┘
```

### 関数 API (TSB バリアント、 1.20.4-tsb/ で生成)

| 関数 | 配置 | 役割 |
|---|---|---|
| `animated_java:global/load_tick` | global.mcb で生成、 `minecraft:tick` タグに登録 | 毎 tick `aj.global:state d.queue_order[0]` を確認、 あれば dispatch_step を呼ぶ |
| `animated_java:global/load_dispatch_step` | global.mcb で生成 | `$function aj:$(queue_order[0])/load/step` でマクロ展開 |
| `aj:<bp>/load/init_queue` | createAnimationStorageTsb で生成 (per-bp) | 自 bp queue を `set value` で上書き + global active membership ガード + queue_order append (重複登録なし) |
| `aj:<bp>/load/step` | createAnimationStorageTsb で生成 (per-bp) | 既存 load/tick の 1 pop ロジック + 末尾で rotate_active / remove_from_global の分岐 |
| `aj:<bp>/load/rotate_active` | createAnimationStorageTsb で生成 (per-bp) | `data remove ... queue_order[0]` + `data modify ... queue_order append "<bp_id>"` |
| `aj:<bp>/load/remove_from_global` | createAnimationStorageTsb で生成 (per-bp) | `data remove ... queue_order[0]` + `data remove ... active.<bp_id>` |
| `aj:<bp>/load/pop/{immediate,high,low}` | 既存維持 | 既存ロジック (queue から先頭を取って dispatch) |
| `aj:<bp>/load/dispatch` | 既存維持 | `$function $(pop) {_: ""}` 既存マクロ展開 |
| `aj:<bp>/load/tick` | **削除** | 旧 schedule 自己再帰版は廃止 |

### namespace 設計判断

- function namespace : **`animated_java:global/...`** を流用 (upstream 既存 namespace、 mcb の `dir global` 内に閉じる)
- storage namespace : **`aj.global:state`** を新設 (per-bp の `aj.<bp>:state` と同じ系統で命名統一)
- 関数だけ namespace 不一致になるが、 mcb の dir 機構で素直に書ける優先 + upstream への影響を最小化 (TSB バリアントのみ load_tick / load_dispatch_step が増えるだけ、 既存関数は無改変)

### init_queue の改修詳細

```mcfunction
# aj:<bp>/load/init_queue

# 自 bp queue を完全上書き (リロード時の旧残骸を消す、 set value は MC ソース確認で O(N) 単純 replace)
data modify storage aj.<bp>:state d.queue.immediate set value []
data modify storage aj.<bp>:state d.queue.high set value []
data modify storage aj.<bp>:state d.queue.low set value ["<expand_ref_1>", "<expand_ref_2>", ...]

# global active membership 重複ガード (リロードで二重登録しない)
execute unless data storage aj.global:state d.active.<bp_id> run data modify storage aj.global:state d.queue_order append value "<bp_id>"
data modify storage aj.global:state d.active.<bp_id> set value 1b

# schedule は不要 (global load_tick が minecraft:tick タグで常駐監視)
```

注意点 :

- queue 上書きは `set value` (MC ソース上 O(N) 単純 replace、 副作用なし、 merge 経路に乗らない、 `NbtPathArgument.java:621` で 1 度 `copy()` + `CompoundTag.java:214` で HashMap 置換)
- リロードで旧 queue 残骸が消える + 削除アニメへの古い expand 参照も消える (= 不存在 function 呼び出しエラーを未然に防ぐ)
- active membership は `aj.global:state d.active.<bp_id>` の compound key で持つので、 list 内の値検査を回避

### step の改修詳細

```mcfunction
# aj:<bp>/load/step (旧 load/tick の置き換え)

# 既存 load/tick と同じ 1 pop ロジック (immediate → high → low の優先度)
execute if data storage aj.<bp>:state d.queue.immediate[0] run return run function aj:<bp>/load/pop/immediate
execute if data storage aj.<bp>:state d.queue.high[0] run return run function aj:<bp>/load/pop/high
execute if data storage aj.<bp>:state d.queue.low[0] run function aj:<bp>/load/pop/low

# 末尾で queue 残量を判定 → round-robin か remove
execute if data storage aj.<bp>:state d.queue.immediate[0] run return run function aj:<bp>/load/rotate_active
execute if data storage aj.<bp>:state d.queue.high[0] run return run function aj:<bp>/load/rotate_active
execute if data storage aj.<bp>:state d.queue.low[0] run return run function aj:<bp>/load/rotate_active
function aj:<bp>/load/remove_from_global
```

```mcfunction
# aj:<bp>/load/rotate_active
data remove storage aj.global:state d.queue_order[0]
data modify storage aj.global:state d.queue_order append value "<bp_id>"
```

```mcfunction
# aj:<bp>/load/remove_from_global
data remove storage aj.global:state d.queue_order[0]
data remove storage aj.global:state d.active.<bp_id>
```

### global load_tick / dispatch_step (global.mcb で生成、 TSB 専用)

```mcfunction
# animated_java:global/load_tick (minecraft:tick タグ登録)
execute unless data storage aj.global:state d.queue_order[0] run return 0
function animated_java:global/load_dispatch_step with storage aj.global:state d.queue_order[0]
```

```mcfunction
# animated_java:global/load_dispatch_step
$function $(id)/load/step
```

注意 : `bpId` は元の resourceLocation 全体 (例 `aj:demo_boss`)、 namespace 込みでマクロ展開する。
これにより bp namespace が `aj` 以外でも対応可能 (例 `mybp:demo_boss/load/step`)。 `with storage`
は `queue_order[0]` の compound (`{id:"<bpId>"}`) を root として渡し、 `$(id)` でマクロ取り出し。

mcb 構文 (`1.20.4-tsb/global.mcb` の `dir global` 内に追記) :

```mcb
IF (tsb_optimized_export && has_animations) {
    function load_tick minecraft:tick {
        execute unless data storage aj.global:state d.queue_order[0] run return 0
        function *global/load_dispatch_step with storage aj.global:state d.queue_order[0]
    }
    function load_dispatch_step {
        $function $(id)/load/step
    }
}
```

`function on_tick minecraft:tick { ... }` は upstream で既出の mcb 糖衣 (line 24)、 これに倣う。

### cleanup の追加項目

`aj:<bp>/cleanup.mcfunction` の末尾に global state 後始末を追加 :

```mcfunction
# 既存 4 行 (per-bp storage の d 配下削除) + remove_animation_objectives 呼び出しに追加
data remove storage aj.global:state d.queue_order[{}]    # NG: list 内文字列値削除は MC vanilla で不可
```

問題 : NBT list の string 値削除は MC vanilla 1.20.4 でできない (compound list なら `[{key:value}]` filter 可能、 string list は不可)。

→ 対応 : queue_order を compound list に変更 :

```
aj.global:state d.queue_order = [
  {id: "<bp_id_1>"},
  {id: "<bp_id_2>"},
  ...
]
```

これに合わせて load_dispatch_step も書き換え :

```mcfunction
# 旧: $function aj:$(queue_order[0])/load/step
# 新: $function aj:$(id)/load/step  (with storage で queue_order[0] を root に渡す)
```

dispatch_step の呼び出し側 :

```mcfunction
# animated_java:global/load_tick
execute unless data storage aj.global:state d.queue_order[0] run return 0
function animated_java:global/load_dispatch_step with storage aj.global:state d.queue_order[0]
```

cleanup での global 削除 :

```mcfunction
# aj:<bp>/cleanup の末尾
execute if data storage aj.global:state d.queue_order[{id:"<bp_id>"}] run data remove storage aj.global:state d.queue_order[{id:"<bp_id>"}]
execute if data storage aj.global:state d.active.<bp_id> run data remove storage aj.global:state d.active.<bp_id>
```

### force_load の発火条件 (Phase C 実装、 仕様だけ確定)

- 旧案 : `execute if data storage aj.<bp>:anim d.<anim>.bones.0` (SNBT 存在チェック)
- **新案** : `execute unless data storage aj.<bp>:state d.loaded.<anim>` (loaded フラグ判定)

理由 :

- SNBT 存在チェックは部分 load 中 (一部 cell のみ展開済み) でも true を返す → 不完全な状態で force_load が走らず、 残り cell 未展開のまま再生
- loaded フラグは最終バッチ末尾で `set value 1b` が立つ → 完全 load 完了の保証
- Phase C の summon / 戦闘要求側で `execute unless data storage aj.<bp>:state d.loaded.<anim> run function aj:<bp>/force_load/<anim>` の形で呼ぶ
- force_load 関数自体は既存通り全 expand を順次同期呼び出し (最終バッチで loaded = 1b)

## 各論の根拠

### data modify set value の負荷検証 (MC ソース確認、 2026-05-22)

`/home/ubuntu/mc-decompiled/1.20.4-server/` 調査結果 :

- `DataCommands.java:125` → `NbtPathArgument.java:616-637` (set value 経路)
- `NbtPathArgument.java:621` で新値を `copy()` (O(N))、 path 終端の `setTag()` で `CompoundTag.put()` (HashMap 単純置換、 O(1))
- 旧値サイズを参照する経路なし、 merge 系の再帰結合 (`CompoundTag.java:513-529`) には乗らない
- `StorageDataAccessor.java:53-54` → `CommandStorage.java:38` で HashMap 更新 + `setDirty()` のみ、 block update / event / scoreboard 発火なし

→ **set value は新値サイズに O(N) で単純 replace、 副作用ゼロ**。 リロード時の重複展開 (= 同じ expand 関数が新キューに再度詰まる) が起きても、 結果は等しく、 work は 2 倍になるだけで構造的に破綻しない (= イーラ君の直感は完全に正しかった)。

### ちぇん氏改造版の load 構造調査 (2026-05-22)

`/home/ubuntu/aj-workspace/repos/animated-java-chen/` + `/home/ubuntu/tsb-workspace/repos/Asset-AnimatedJava/AnimatedJava/` 調査結果 :

- 段階展開 (cells_per_tick 概念) は **存在しない** (全 frame data を on_load 時に巨大マクロで storage に詰める方式)
- `minecraft:tick` タグに `animated_java:global/on_tick` が登録されている (`data/minecraft/tags/functions/tick.json`)、 関数タグ `animated_java:global/root/on_tick` に全 blueprint の on_tick を集約
- force_load 判定は `IS_RIG_LOADED` scoreboard フラグ ベース (`animation.mcb:42` で `execute unless score @s ... matches 1 run function #*global/root/on_load`)
- リロード時 cleanup は `kill @e[tag=<%TAGS.GLOBAL_ENTITY()%>]` のグローバルタグ kill 一発 (storage queue / delay reset なし、 全 rig 再 summon )

→ ちぇん氏設計は「全 blueprint が minecraft:tick タグ経由で毎 tick 全実行」 で、 段階展開や budget 管理は未実装。 我々の Phase B-1.5 は **段階展開を保ちつつグローバル化** する点で完全新規領域だが、 「`minecraft:tick` タグで global on_tick を常駐」 という骨格はちぇん氏改造と同じ路線。

### 旧案 A〜D との対比

| 案 | 対比 | 採用 |
|---|---|---|
| A. global schedule (集中制御) | namespace `aj:global` 導入を保留して `animated_java:global` 流用に切替、 schedule → minecraft:tick タグに変更、 per-bp queue + active list の構造を追加 | △ (発展形 = 案 A' で採用) |
| B. cells_per_tick の共有 budget | order/active 構造で round-robin、 budget 共有は実質達成 | △ (案 A' に統合) |
| C. 順次ロード (1 bp ずつ完走) | round-robin で公平性確保、 「先着優先で他 bp が待つ」 問題を回避 | × (案 A' で公平性優先) |
| D. 現状維持 + 運用ガイド | Phase D 待ちで先延ばしせず、 段階展開と並行で Phase B-1.5 で実装 | × |

### load 中 reload の挙動 (確認結果)

旧設計検討 (案 D 時) からの結論を維持 :

1. 旧 datapack の load/tick (= 旧 step) が動作中
2. `/reload` 実行 → 新 datapack の on_load → 新 init_queue
3. 新 init_queue で **自 bp queue は `set value` で完全上書き** (旧残骸は消える、 削除アニメへの参照も消える)
4. 新 init_queue で **global active に対しては `unless` ガード経由で append**、 既に登録済みなら何もしない
5. 旧 schedule は不在 (= 廃止)、 minecraft:tick タグの load_tick が常駐し続けるため、 reload を跨いで継続動作

→ schedule 不在 = `schedule ... replace` の取り扱いを考えなくて良い (イーラ君が懸念していた点を解消)。

reload 中に進行中だった expand が中断された場合の挙動 :
- expand 関数 (= バッチ N の `set value` 行) は単一 mcfunction の中で実行、 atomic
- pop した時点で queue から削除済み、 reload 後の新 queue は同じバッチを再度 pop する (= バッチ N が新 queue で先頭にあるなら 2 重実行、 結果整合的 / 一致しないなら旧 N 分はロスト、 ただし新 queue が完全 reload なので不問)
- 進行中バッチが新 datapack 上で削除されていても、 `function ... not found` エラーは出ない (= 自 bp queue を完全上書きで該当参照が消えるため)

### アイドル時の常駐コスト

`animated_java:global/load_tick` を毎 tick 走らせる場合のアイドル時負荷 :

- 中身 : `execute unless data storage aj.global:state d.queue_order[0] run return 0` の 1 命令 (条件 false 時は次行を実行、 condition true 時は早期 return)
- アイドル時 (queue_order が空) : 1 命令で return → 数 μs オーダー
- schedule 方式と比較 : schedule のアイドル時は 0 命令 だが、 reload 時の `schedule replace` 取り扱いコストが追加
- ちぇん氏改造版の `animated_java:global/on_tick` も同じ規模で常駐 → 既存運用で実績あり

→ 許容範囲 (実機での影響は無視できる)。

## 未決事項 / 残課題

- [ ] queue_order を compound list (`[{id:"<bp>"}]`) で持つ仕様、 storage spec に反映 ([[aj-phase-a-spec]] の state フォーマットセクション更新要)
- [ ] cells_per_tick の解釈を「1 expand 関数 (= 1 step pop) に詰める cell 上限」 で確定、 docs 明記
- [ ] 実機検証 (Phase D) : 2 体以上の bp を同時 reload して、 全体 budget が 1 expand /tick に収まること確認
- [ ] Phase B-1.5 完了後の `aj.global:state` 残留チェック (datapack 全削除時の手動 cleanup 推奨を README に明記)

## 関連ドキュメント

- 上位仕様 : `~/docs-workspace/next-tasks/animated-java-optimization.md`
- 出力サンプル : `~/docs-workspace/animated-java/tsb-output-sample.md`
- 検証手順 : `~/docs-workspace/animated-java/tsb-phase-b1-verification.md`
- 設計経緯 : 本ファイル
- cleanup の経緯 : `cleanup-on-load-removed.md` (on_load 自動 cleanup 削除)
- データ remove 構文の経緯 : `cleanup-data-remove-syntax.md` (ラッパー段 d 導入)
