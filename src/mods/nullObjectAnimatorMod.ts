import { registerPatch } from 'blockbench-patch-manager'
import { activeProjectIsBlueprintFormat } from '../formats/blueprint'
import EVENTS from '../util/events'

// BB animation.js:105 の bone fallback で過去に BoneAnimator として永続化された
// NullObject の animator entry を NullObjectAnimator に再 instantiate する救済
// (= 仮説 D 既存救済 migration)。 案 1 (animation.ts 内 type 矯正) が新規腐敗を
// 防いだ後も、 既存 blueprint には壊れた entry が残るためここで一括移行する。
// plugin load 経路を絶対に止めないため try/catch で silent fail に倒す。

function migrateNullObjectAnimators(): void {
	try {
		if (!activeProjectIsBlueprintFormat()) return
		if (typeof NullObject === 'undefined' || typeof NullObjectAnimator === 'undefined') return
		if (typeof OutlinerNode === 'undefined') return

		let migratedAny = false
		for (const animation of Blockbench.Animation.all) {
			for (const uuid in animation.animators) {
				try {
					const animator = animation.animators[uuid]
					if (!animator) continue
					const elem = OutlinerNode.uuids?.[uuid]
					if (!(elem instanceof NullObject)) continue
					if (animator instanceof NullObjectAnimator) continue

					const replacement = new NullObjectAnimator(uuid, animation, animator.name)
					for (const kf of animator.keyframes) {
						;(kf as any).animator = replacement
						replacement.keyframes.push(kf)
					}
					animation.animators[uuid] = replacement
					migratedAny = true
					console.info(
						`[AJ] Migrated BoneAnimator → NullObjectAnimator for ${uuid} (${animator.name})`
					)
				} catch (e) {
					console.warn(`[AJ] NullObject migration failed for uuid=${uuid}:`, e)
				}
			}
		}

		// migration が走った場合、 旧 BoneAnimator の keyframe が Timeline.selected に orphan 参照として
		// 残る可能性がある (= reviewer 指摘 C2)。 SELECT_AJ_PROJECT は通常 project 切替直後で
		// Timeline.selected は空のはずだが、 同セッション内で別 project から切り替えたケースで
		// 旧参照が残ると後続の kf.selected 操作が壊れた state に遷移する。 確実に整合を取るため
		// migration 後は Timeline.selected を clear する。
		if (
			migratedAny &&
			typeof Timeline !== 'undefined' &&
			Array.isArray(Timeline.selected) &&
			Timeline.selected.length > 0
		) {
			for (const kf of Timeline.selected.slice()) {
				try {
					;(kf as any).selected = false
				} catch {
					/* noop */
				}
			}
			Timeline.selected.length = 0
		}
	} catch (e) {
		console.error('[AJ] NullObject migration mod fatal:', e)
	}
}

// top-level subscribe を patch 化 (= reviewer 指摘 B7)。 plugin reload 時に重複登録を防ぎ、
// 他の mod (registerPatch で cleanup 持つ) と設計を揃える。 subscribe 戻り値 = unsubscribe 関数。
registerPatch({
	id: 'animated_java:null-object-migration',
	apply: () => {
		return EVENTS.SELECT_AJ_PROJECT.subscribe(migrateNullObjectAnimators)
	},
	revert: unsubscribe => {
		if (typeof unsubscribe === 'function') {
			try {
				unsubscribe()
			} catch {
				/* noop */
			}
		}
	},
})
