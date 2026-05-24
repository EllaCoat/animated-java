import { observable } from 'svelte-observable-store'
import { SvelteDialog } from 'svelte-patching-tools/blockbench'
import { PACKAGE } from '../../constants'
import { localize as translate } from '../../util/lang'
import AniamtionPropertiesSvelteComponent from './animationProperties.svelte'

export const DIALOG_ID = `${PACKAGE.name}:animationPropertiesDialog`

export function openAnimationPropertiesDialog(animation: _Animation) {
	const animationName = observable(animation.name)
	const loopMode = observable(animation.loop as string)
	const loopDelay = observable(Number(animation.loop_delay) || 0)
	const excludedNodes = observable(animation.excluded_nodes)
	const tsbPriority = observable(animation.tsb_priority || 'low')
	const tsbOptimizedEnabled = !!Project?.animated_java?.tsb_optimized_export

	new SvelteDialog({
		id: DIALOG_ID,
		title: translate('dialog.animation_properties.title', animation.name),
		width: 600,
		component: AniamtionPropertiesSvelteComponent,
		props: {
			animationName,
			loopMode,
			loopDelay,
			excludedNodes,
			tsbPriority,
			tsbOptimizedEnabled,
		},
		disableKeybinds: true,
		onConfirm() {
			animation.name = animationName.get()
			animation.createUniqueName(Blockbench.Animation.all)
			animation.loop = loopMode.get() as any
			animation.loop_delay = loopDelay.get().toString()
			animation.excluded_nodes = excludedNodes.get()
			if (tsbOptimizedEnabled) {
				animation.tsb_priority = tsbPriority.get() as 'immediate' | 'high' | 'low'
			}

			Project!.saved = false
		},
	}).show()
}
