# TSB Known Issue: 複数 AJ プロジェクトの並列 load tick 負荷 + load 中 reload の挙動

- **ステータス**: 議論中 (設計案 4 件を提示、 ユーザー判断待ち)
- **発見日**: 2026-05-22 (ユーザーから運用観点の懸念として提起)
- **重大度**: 中 (現状 + 複数 blueprint 同時 active 環境で線形に重くなる、 開発時のみ顕在化)
- **発生箇所**: `src/systems/datapackCompiler/createAnimationStorageTsb.ts` の `buildLoadTick` / `buildInitQueue`

## 問題 1: 並列 load tick

### 現状の構造

各 blueprint は独立に load/tick を持ち、 `schedule function aj:<bp>/load/tick 1t replace` で
自己再 schedule する。 N 個の blueprint が同時 active なら、 毎 tick で N 回の load/tick が
走り、 それぞれが自分の `cells_per_tick` (default 1000) を消費する。

→ **全体 budget は N × cells_per_tick**。 N に線形比例して重くなる。

### シナリオ

- アキシャ (~43200 cells) + 別 boss (~30000 cells) が同時に reload された場合
- 各 blueprint が 43 tick / 30 tick で展開完了するが、 その間は 2000 cells/tick 消費
- 3 体目以降を入れると線形に増加 → tick 詰まり / TPS 低下のリスク

通常運用では「全 boss を同時に reload する」 シーンは少ない (= 開発時のみ問題化)、 だが
プロジェクトが増えるほど顕在化する。

## 設計案 4 件

### 案 A: グローバル schedule (集中制御)

`aj:global/load/tick` という共通関数を新設し、 各 blueprint の load/tick を順番に呼ぶ。
各 blueprint の `init_queue` は global pending list に自分を append する。

```mcfunction
# aj:global/load/tick (全 blueprint 共通、 改造後 AJ で 1 個だけ生成)
execute if data storage aj:global pending[0] run function aj:global/dispatch with storage aj:global
execute if data storage aj:global pending[0] run schedule function aj:global/load/tick 1t replace
```

- **メリット** : 全体 budget が確実に 1 × cells_per_tick に収まる、 並列負荷ゼロ
- **デメリット** : 専用 namespace `aj:global` の導入、 既存 AJ ユーザーに影響する可能性、 cells_per_tick がプロジェクト共有になるので個別チューニング不可
- **推奨度** : 高 (TSB バリアントのみで完結させる前提なら)

### 案 B: cells_per_tick の共有 budget (緩い制御)

各 blueprint の load/tick 冒頭で global counter を見て budget 残量があれば実行、 無ければ
skip。 budget は毎 tick リセット。

```mcfunction
# aj:<bp>/load/tick の冒頭
execute if score #aj.global.budget aj.i matches ..0 run return run schedule function aj:<bp>/load/tick 1t replace
scoreboard players remove #aj.global.budget aj.i <%cells_per_tick%>
function aj:<bp>/load/tick/work  # 実際の pop + dispatch
```

- **メリット** : 既存の per-blueprint 構造を維持しつつ全体 budget を保護
- **デメリット** : 同じ tick 内で複数 blueprint が走る → 順序保証なし。 budget リセットの仕組みが別途必要
- **推奨度** : 中

### 案 C: 順次ロード (1 blueprint ずつ完走)

「現在 load 中の blueprint」 を 1 つだけに制限。 各 blueprint の init_queue は global lock を
取得してから自分の load/tick を起動。 完了したら lock 解放 + 次の bp の load 開始。

- **メリット** : シンプル、 budget の概念が要らない
- **デメリット** : 待機中の blueprint の force_load fallback が必要 (戦闘要求が来たら強制展開)、 順序固定
- **推奨度** : 中〜低 (待機ロジックが複雑、 force_load との整合性確保が課題)

### 案 D: 現状維持 + 運用ガイド

実装変更なし、 運用面で対処する。

- 同時に load させる blueprint 数を絞る (= 開発時のみ問題なので、 開発者が手動で順次 reload)
- `cells_per_tick` を blueprint 数で割って設定する運用 (例 : 3 体同時なら 333 を各 bp に設定)
- README に「複数 blueprint 同時 reload は重い、 reload は順次で」 を明記

- **メリット** : 実装コストゼロ、 Phase D の実機検証で問題化しなければ十分
- **デメリット** : 実機でストレスが出たら結局案 A〜C のどれかが必要
- **推奨度** : Phase D 検証までは妥当、 検証で問題が出たら案 A への移行

## 問題 2: load 中の reload 挙動

### 整理

シナリオ : 旧 datapack が load/tick で queue を消費中、 `/reload` が実行された場合。

1. 旧 datapack の `schedule function aj:<bp>/load/tick 1t replace` が動作中
2. `/reload` 実行 → 新 datapack の on_load が走る (cleanup は呼ばれない、 上記 `cleanup-on-load-removed.md` 参照)
3. 新 `init_queue` が `data modify storage ... d.queue.* set value [...]` で queue を **上書き**
4. 新 `schedule function aj:<bp>/load/tick 1t replace` で旧 schedule を **破棄** + 新 schedule
5. 以降は新 datapack の load/tick が新 queue を消費 → 新 expand を呼ぶ

### 結論

**構造的には安全**。 `schedule ... replace` で旧 schedule が破棄され、 新 init_queue で queue
が上書きされるため、 重複実行 / 不整合は起きない。

ただし以下の注意点 :

- 旧 anim NBT のうち、 新 datapack に存在しないアニメは **残骸として残る** (削除されたアニメ)
- 上書きされるアニメは順次新値に更新 (= 旧値 → 新値の混在状態が一時的に発生するが、 視覚的に問題なし)
- 削除アニメの残骸を消すには **reload 前に手動 cleanup** が必要 (運用ガイドに明記)

### 実機検証で確認したいこと (Phase D)

- [ ] 大きなアニメを load 中に `/reload` を実行 → エラーログが出ないこと
- [ ] reload 後、 旧 queue の残りが実行されないこと (`schedule replace` が効いていること)
- [ ] 削除されたアニメの NBT が残骸として残ること、 手動 cleanup で消えること

## 要決定事項

- 案 A / B / C / D のどれを採用するか
- 実装する場合の優先度 (Phase B-1 系の続編か、 Phase D 実機検証後か)
- 案 A 採用時 : `aj:global` namespace の取り扱い (upstream 影響範囲、 既存ユーザーへの影響)
