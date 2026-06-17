import { activeProjectIsBlueprintFormat } from '../formats/blueprint'
import EVENTS from '../util/events'

// BB animation.js:105 の bone fallback で過去に BoneAnimator として永続化された
// NullObject の animator entry を NullObjectAnimator に再 instantiate する救済
// (= 仮説 D 既存救済 migration)。 案 1 (animation.ts 内 type 矯正) が新規腐敗を
// 防いだ後も、 既存 blueprint には壊れた entry が残るためここで一括移行する。
// plugin load 経路を絶対に止めないため try/catch で silent fail に倒す。
EVENTS.SELECT_AJ_PROJECT.subscribe(() => {
	try {
		if (!activeProjectIsBlueprintFormat()) return
		if (typeof NullObject === 'undefined' || typeof NullObjectAnimator === 'undefined') return
		if (typeof OutlinerNode === 'undefined') return

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
					console.info(
						`[AJ] Migrated BoneAnimator → NullObjectAnimator for ${uuid} (${animator.name})`
					)
				} catch (e) {
					console.warn(`[AJ] NullObject migration failed for uuid=${uuid}:`, e)
				}
			}
		}
	} catch (e) {
		console.error('[AJ] NullObject migration mod fatal:', e)
	}
})
