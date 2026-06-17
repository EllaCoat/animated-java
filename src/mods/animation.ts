import { registerPatch, registerPropertyOverridePatch } from 'blockbench-patch-manager'
import { openAnimationPropertiesDialog } from '../dialogs/animationProperties/animationProperties'
import { activeProjectIsBlueprintFormat } from '../formats/blueprint'
import { localize as translate } from '../util/lang'
import { roundToNth } from '../util/misc'

declare global {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface _Animation {
		excluded_nodes: CollectionItem[]
		tsb_priority?: 'immediate' | 'high' | 'low'
	}

	interface AnimationUndoCopy {
		excluded_nodes: string[]
		tsb_priority?: 'immediate' | 'high' | 'low'
	}

	interface AnimationOptions {
		excluded_nodes: string[]
		tsb_priority?: 'immediate' | 'high' | 'low'
	}
}

export const DEFAULT_SNAPPING_VALUE = 20
export const MINIMUM_ANIMATION_LENGTH = 0.05

//region Extend
registerPropertyOverridePatch({
	id: `animated_java:function-override/animation/extend`,
	target: Blockbench.Animation.prototype,
	key: 'extend',

	getCondition: () => activeProjectIsBlueprintFormat(),

	get: original => {
		return function (this: _Animation, data?: AnimationOptions) {
			// BB animation.js:105 の bone fallback で NullObject の animator が
			// BoneAnimator として復元される問題の回避 (= 仮説 D 新規腐敗防止)。
			// load 直前に animators[uuid].type を element の実型に矯正する。
			// plugin load 経路を絶対に止めないため try/catch で silent fail に倒す。
			try {
				const animators = (data as any)?.animators as
					| Record<string, { type?: string } | undefined>
					| undefined
				if (animators && typeof OutlinerNode !== 'undefined') {
					for (const uuid in animators) {
						const entry = animators[uuid]
						if (!entry) continue
						const elem = OutlinerNode.uuids?.[uuid]
						if (
							typeof NullObject !== 'undefined' &&
							elem instanceof NullObject &&
							entry.type !== 'null_object'
						) {
							entry.type = 'null_object'
						}
					}
				}
			} catch (e) {
				console.warn('[AJ] NullObject animator type correction skipped:', e)
			}
			original.call(this, data)
			this.snapping = DEFAULT_SNAPPING_VALUE
			this.length = Math.max(this.length, MINIMUM_ANIMATION_LENGTH)
			for (const animator of Object.values(this.animators)) {
				if (!animator) continue
				let lastTime = -Infinity
				for (const kf of animator.keyframes) {
					let rounded = roundToNth(kf.time, DEFAULT_SNAPPING_VALUE)
					if (rounded === kf.time) continue
					if (rounded === lastTime) rounded += 0.05
					kf.time = rounded
					lastTime = rounded
				}
			}
			return this
		}
	},
})

//region Set Length
registerPropertyOverridePatch({
	id: `animated_java:function-override/animation/set-length`,
	target: Blockbench.Animation.prototype,
	key: 'setLength',

	getCondition: () => activeProjectIsBlueprintFormat(),

	get: original => {
		return function (this: _Animation, length?: number) {
			length = Math.max(length ?? this.length, MINIMUM_ANIMATION_LENGTH)
			return original.call(this, length)
		}
	},
})

//region Properties Dialog
registerPropertyOverridePatch({
	id: `animated_java:function-override/animation/properties-dialog`,
	target: Blockbench.Animation.prototype,
	key: 'propertiesDialog',

	getCondition: () => activeProjectIsBlueprintFormat(),

	get: () => {
		return function (this: _Animation) {
			if (!Blockbench.Animation.selected) {
				Blockbench.showQuickMessage('No animation selected')
				return
			}
			openAnimationPropertiesDialog(Blockbench.Animation.selected)
		}
	},
})

//region Properties
registerPatch({
	id: `animated_java:property-definitions/animation`,

	apply: () => {
		const excludedNodesProperty = new Property(
			Blockbench.Animation,
			'array',
			'excluded_nodes',
			{
				condition: () => activeProjectIsBlueprintFormat(),
				label: translate('animation.excluded_nodes'),
				default: [],
			}
		)
		const tsbPriorityProperty = new Property(
			Blockbench.Animation,
			'string',
			'tsb_priority',
			{
				condition: () =>
					activeProjectIsBlueprintFormat() &&
					!!Project?.animated_java?.tsb_optimized_export,
				label: translate('animation.tsb_priority'),
				default: 'low',
			}
		)

		return { excludedNodesProperty, tsbPriorityProperty }
	},

	revert: ({ excludedNodesProperty, tsbPriorityProperty }) => {
		excludedNodesProperty.delete()
		tsbPriorityProperty.delete()
	},
})

//region Force Saved
registerPropertyOverridePatch({
	id: `animated_java:animation-force-saved`,
	target: Blockbench.Animation.prototype,
	key: 'saved',

	getCondition: () => activeProjectIsBlueprintFormat(),

	get: () => true,

	set: () => true,
})

//region Save All Action
registerPropertyOverridePatch({
	id: `animated_java:action-condition-override/save-all-animations`,
	target: BarItems.save_all_animations as Action,
	key: 'condition',

	getCondition: () => activeProjectIsBlueprintFormat(),

	get: () => false,
})
