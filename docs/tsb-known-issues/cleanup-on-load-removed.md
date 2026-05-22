# TSB Known Issue: on_load の自動 cleanup 呼び出しを削除 (2026-05-22)

- **ステータス**: 解決済 (load 時自動 cleanup 削除 + cleanup.mcfunction に scoreboard 削除追加)
- **発見日**: 2026-05-22 (Phase B-1-shear 後、 ユーザーから運用上の懸念として指摘)
- **重大度**: 高 (load 時 cleanup 自動呼び出しを残したままだと、 ボス戦中のサーバ停止 → 再起動でストレージが消える → プレイヤー進行を破壊)
- **発生箇所**: `src/systems/datapackCompiler/1.20.4-tsb/main.mcb` の `on_load`

## 問題

これまでは `on_load` 冒頭で `function <%blueprint_id%>/cleanup` を自動呼び出ししていた。 これは
「reload 時に旧データを完全消去する」 安全策として導入されたものだが、 以下のシナリオで
プレイヤー進行を破壊する :

1. プレイヤーがボス戦中
2. サーバが停止 (クラッシュ / 再起動 / 強制終了)
3. サーバ再起動 → datapack の on_load が走る → cleanup 発火 → storage 全削除
4. ボス NBT / アニメ状態が全消失 → 戦闘が壊れる

実運用ではアニメーションデータの変更は **開発環境時のみ** に限定されるため、 reload 時の
強制 cleanup は不要。 残骸データは新 datapack の `set value` で順次上書きされるので、
動作には影響しない。

## 対応

`1.20.4-tsb/main.mcb` の `on_load` から `function <%blueprint_id%>/cleanup` 行を削除。
TSB ブランチは以下に :

```mcb
IF (tsb_optimized_export) {
    # TSB Optimized Export : on_load では cleanup を呼ばない (load 中サーバ再起動 / 戦闘中 reload で
    # プレイヤーの進行を巻き戻す危険があるため)。 cleanup は datapack disable 直前に
    # ボス制御 mcfunction から手動で呼ぶ運用に統一。
    # anim NBT は on_load では展開せず、 段階展開キュー経由でロード。
    # 既存ストレージへの set value は単純上書きなので残骸 cell があっても新 datapack の値で上書きされる。
}
```

`function <%blueprint_id%>/load/init_queue` の呼び出しは引き続き on_load で行う (queue 初期化 +
schedule 起動)。 `set value` は上書きなので残骸が混じることはない。

## cleanup.mcfunction の強化 (同セッション)

cleanup を手動呼び出し限定にしたので、 cleanup の中身を強化して **scoreboard objectives も削除**
できるようにした。 削除対象は **animation 単位の objective** (`aj.<animationName>.frame`) のみ :

```mcfunction
execute if data storage aj.<bp>:anim d run data remove storage aj.<bp>:anim d
execute if data storage aj.<bp>:variants d run data remove storage aj.<bp>:variants d
execute if data storage aj.<bp>:state d run data remove storage aj.<bp>:state d
execute if data storage aj.<bp>:tmp d run data remove storage aj.<bp>:tmp d
scoreboard objectives remove aj.<anim_1>.frame
scoreboard objectives remove aj.<anim_2>.frame
...
```

グローバル共有 objectives (`aj.i` / `aj.id` / `aj.is_rig_loaded` / `aj.tween_duration`) は
**他の blueprint も使うため削除しない**。 `scoreboard objectives remove` は対象が無くても
silent fail のため、 ガード不要。

## 運用上の必須事項 (改造後 AJ README に明記すべき)

- **データパック disable の直前**、 TSB ユーザー (ボス制御 mcfunction) が必ず `function aj:<bp>/cleanup`
  を呼ぶこと。 呼ばないと storage / scoreboard が永続化されてワールド データに残る
- **アニメーションを変更してから reload する場合** (= 開発時) は、 reload 前に手動で
  `function aj:<bp>/cleanup` を実行することを推奨。 reload 時の自動 cleanup はしないため、
  旧 anim NBT が残骸として残る可能性がある (新 datapack で同じ anim 名なら set value で
  自動上書きされるが、 削除されたアニメは残骸として残る)
- **load 中の reload** : `schedule ... replace` で旧 schedule は破棄され、 新 init_queue で
  queue が `set value` で上書きされるため、 構造的には安全。 ただし旧 anim NBT は残るので、
  上記の「reload 前手動 cleanup」 を併用するのが安全

## 関連

- `cleanup-data-remove-syntax.md` : 固定ラッパー段 `d` 導入の経緯
- `shear-dropped-by-trs-decomposition.md` : 7/10/14 floats 自動判定 + SVD 分解の経緯
