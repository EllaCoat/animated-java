# TSB Optimization: animation_hash 判定で reload 時のキュー再構築をスキップ (2026-05-22)

- **ステータス**: 実装済 (2026-05-22 夜)
- **重大度**: 機能拡張 (バグではなく最適化)
- **発生箇所**: `src/systems/datapackCompiler/1.20.4-tsb/main.mcb` の `on_load`

## 動機

現状の TSB Optimized Export では、 reload のたびに `init_queue` が無条件で走り、
55+ 個の expand 関数を段階展開し直していた。 アニメーション内容に変化が無い場合でも
全 cell の `set value` が再実行され、 開発時の reload や運用中の reload で
コストが嵩んでいた。

同 datapack の reload (= 変更無し reload) で**何もしない**ことが本機能の本命。
副次的に datapack 入れ替え (= ハッシュ違う) では正常に再展開される。

## 技術根拠 (mc-decompiled 確認済)

Minecraft 1.20.4 の `DataCommands.java:36` に以下の定義あり :

```java
private static final SimpleCommandExceptionType ERROR_MERGE_UNCHANGED =
    new SimpleCommandExceptionType(
        Component.translatable("commands.data.merge.failed")
    );
```

`commands.data.merge.failed` の翻訳キーは `"Nothing changed. That's already the value."`。

- `data modify storage <ns> <path> set value <value>` で **同一値**を代入した場合、
  上記の例外が throw される (= command 失敗)
- `execute store success score #<scoreHolder> <objective> run data modify ...` で
  この成否を score に store できる :
  - 変更あり (新規追加 / 値変化) → success 1
  - 変更なし (同一値、 throw) → success 0

ログに `Nothing changed. ...` が残るが、 reload のたびに 1 行発生する程度で
プレイヤー進行には無影響、 ログ運用に支障なしと判定。

## 採用設計

`on_load` の末尾 `function <%blueprint_id%>/load/init_queue` を以下の 2 行に置換 :

```mcb
IF (tsb_optimized_export && has_animations) {
    execute store success score #h <%OBJECTIVES.I()%> \
        run data modify storage <%project_storage.replace(':', '.')%>:state d.animation_hash \
        set value "<%animation_hash%>"
    execute if score #h <%OBJECTIVES.I()%> matches 1 \
        run function <%blueprint_id%>/load/init_queue
}
```

`animation_hash` は既存の `hashAnimations()` (`src/systems/animationRenderer.ts:334`)
が SHA-256 で全 frame の time / pos / rot / scale / interpolation / function /
frame.variants を反映して生成する 64 文字 hex 文字列。 アニメーション内容に変化が
あれば必ず別 hash になる。

## シナリオ別挙動

| シナリオ | success score | 挙動 |
|---|---|---|
| 初回 load (state storage 空) | 1 (新規追加) | `init_queue` 実行、 段階展開開始 |
| 同 datapack reload (完全展開済、 hash 一致) | 0 (throw) | **何もしない** (本命のケース) |
| 同 datapack reload (部分展開中、 hash 一致) | 0 (throw) | `init_queue` スキップ。 残ってる per-bp queue は global tick の `load_dispatch_step` が引き続き処理するため、 最終的に完全展開される |
| datapack 入れ替え (hash 不一致) | 1 (書き換え) | `init_queue` 実行、 新 anim で再展開。 旧 storage に残った unreferenced cell はそのまま放置 (許容範囲) |
| cleanup 後の reload (state storage 全削除済) | 1 (新規追加) | 初回 load と同じ、 正常展開 |

## 部分展開中 reload の safety

`init_queue` のスキップで、 既存 per-bp queue がそのまま温存される :

- per-bp queue (`aj.<bp>:state d.queue.{immediate,high,low}`) : 残った pop 待ちの expand 関数群
- global state (`aj.global:state d.active.<bpId>.*` / `d.queue_order.*` / `d.has_work`) : 自 bp が登録された状態が維持

reload は `minecraft:tick` タグ駆動の `animated_java:global/load_tick` を再 schedule しないが、
**`minecraft:tick` タグは reload で消えない**ため、 既存の load_tick が継続実行される。
よって per-bp queue は順次 pop されて完全展開に到達する。

## datapack 入れ替え時の残骸

hash 不一致で `init_queue` 走行 → 新展開時、 旧 storage の cell は **同じ path (`d.<anim>.bones.<id>.<frame_idx>`) なら新値で上書き**される。

問題になるのは「**旧 bp で参照されてたが新 bp では参照されない path**」 (例 : 旧 anim を削除した場合の `d.<削除済 anim>.bones.<id>`)。 これらは新 init_queue の expand 関数群が触らないため、 storage に残骸として残る。

ただし :
- 削除済 anim を新 datapack で再生する経路は存在しない (アニメ実行関数自体も無い)
- ストレージサイズへの影響は cell サイズ × 残骸数で軽微
- 開発フローでは「アニメ削除 → reload」 ではなく「アニメ削除 → 手動 cleanup → reload」 が推奨フロー (既存運用)

これらの理由で、 hash 不一致時の自動 cleanup は **採用しない**。 残骸の完全消去が必要な場合は手動 cleanup (`function aj:<bp>/cleanup`) を使う。

## cleanup との整合性

`cleanup.mcfunction` は state storage の `d` 全削除を行うため、 cleanup 後の reload では
`animation_hash` も無い状態から再展開する。 整合性 OK。

| cleanup の挙動 | 関連 storage 状態 | 次の reload での挙動 |
|---|---|---|
| 手動 cleanup → reload | state.d 全削除 | hash 無し → 不一致扱いで `init_queue` 実行 = 正常展開 |
| reload (cleanup 無し、 同 datapack) | state.d.animation_hash 既存 | hash 一致 → スキップ |

## 実機検証チェックリスト

1. **初回 load**: 新規 export → datapack 投入 → reload → `data/aj/axia/zzz/summon/...` 使ってボスを召喚 → 段階的にアニメが入ってくることを確認
2. **完全展開済 reload**: 上記から数十 tick 待って全 expand 完了 → reload → tellraw / log を確認、 `init_queue` が走らないことを確認 (scoreboard `#h aj.i` が 0)
3. **部分展開中 reload**: 初回 load 直後 (まだ展開中) に即 reload → アニメは引き続き展開され、 最終的に正常再生されること
4. **datapack 入れ替え**: アニメ frame を 1 つ変えて再 export → 上書き reload → hash 不一致で `init_queue` 走行 → 新 anim 再生
5. **scoreboard 確認**: `scoreboard players get #h aj.i` で前回判定値が見られる

## 残課題

- ログに毎回 `Nothing changed. That's already the value.` が出る件は、 必要なら
  `execute on @s ...` 等で suppress する手があるが、 現状放置で運用可と判定 (毎 reload 1 行)
- 将来 `OBJECTIVES.I()` の名前変更で `aj.i` 以外になった場合、 score holder `#h` も
  別 objective に書く必要あり (現状は AJ 全体共通の `aj.i` を流用してる)
