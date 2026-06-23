import { SveltePanel } from 'svelte-patching-tools/blockbench'
import { BLUEPRINT_FORMAT_ID } from '../../formats/blueprint'
import { createScopedTranslator } from '../../util/lang'
import EasingsPanelComponent from './easings.svelte'

const localize = createScopedTranslator('animated_java.panel.easings')

export const EASINGS_PANEL = new SveltePanel({
	id: `animated_java:panel/easings`,
	name: localize('title'),
	component: EasingsPanelComponent,
	expand_button: false,
	// growable: true は sidebar resize 時に隣 static panel へ resize 委譲する経路を発火させて
	// 他 panel サイズを巻き込む (= panels.ts:263-265)。 さらに空 .panel_vue_wrapper が flex-grow:1
	// で伸びて内容を下に押し下げる (= panels.css:26-31)。 両症状とも growable: false で解消。
	growable: false,
	resizable: true,
	icon: 'timeline',
	condition: {
		formats: [BLUEPRINT_FORMAT_ID],
		modes: [Modes.options.animate.id],
	},
	default_position: {
		slot: 'left_bar',
		folded: false,
		float_position: [0, 0],
		float_size: [200, 200],
		height: 200,
		// growable: false 時に sidebar 上で初期 height 200 を効かせるため (= panels.ts:988/996)
		fixed_height: true,
		// @ts-expect-error - Missing types
		attached_to: 'transform',
		attached_index: 1,
		sidebar_index: 2,
	},
	default_side: 'left',
})
