<script lang="ts" module>
	import { onDestroy } from 'svelte'
	import { VanillaBlockDisplay } from '../../outliner/vanillaBlockDisplay'
	import EVENTS from '../../util/events'
	import { localize as translate } from '../../util/lang'
	import { validateBlock } from '../../util/minecraftUtil'
</script>

<script lang="ts">
	let selected = $state(VanillaBlockDisplay.selected.at(0))
	let block = $derived(selected?.block)
	let error = $derived(selected?.error)

	// 非同期 validation の世代番号。 in-flight の validation 結果が今も有効かを判定する。
	// $state ではなく素の let にしている (= effect の依存にすると再実行が無限ループする)。
	let validationGeneration = 0
	const invalidatePendingValidation = () => {
		validationGeneration++
	}

	const onSelectionChanged = () => {
		// $effect は同期実行されないため、 effect cleanup による無効化だけでは
		// この同期ハンドラから effect 再実行までの間に完了した結果がすり抜ける。
		// selection が変わった時点で同期的に世代を進めて、 その窓を塞ぐ。
		invalidatePendingValidation()
		selected = VanillaBlockDisplay.selected.at(0)
		block = selected?.block
		error = selected?.error
	}

	const unsubs = [
		EVENTS.UNDO.subscribe(onSelectionChanged),
		EVENTS.REDO.subscribe(onSelectionChanged),
		EVENTS.UPDATE_SELECTION.subscribe(onSelectionChanged),
	]

	$effect(() => {
		const thisSelected = selected
		const thisBlock = block
		const thisGeneration = validationGeneration
		// validation は非同期なので、 完了順が入力順と一致する保証がない。 以下のいずれかを満たす結果は破棄する。
		// - 世代不一致 = effect の再実行 / component の破棄 / selection の変更 が起きた後の結果。
		//   値の比較では判定できない A→B→A の往復と、 local state が変化しない破棄をここで弾く。
		// - 値不一致 = effect が再実行される前に bind:value 経由で入力が変わった (= effect 遅延実行の窓)。
		const isStale = () =>
			validationGeneration !== thisGeneration ||
			selected !== thisSelected ||
			block !== thisBlock
		error?.set('')
		if (thisSelected && thisBlock && thisSelected.block !== thisBlock) {
			void validateBlock(thisBlock)
				.then(err => {
					if (isStale()) return
					if (err) {
						error?.set(err)
						console.log('Block validation error:', err)
						return
					}
					console.log('Changing block to', thisBlock)
					Undo.initEdit({ elements: [thisSelected] })

					thisSelected.block = thisBlock
					Project!.saved = false

					Undo.finishEdit(`Change Block Display Block to "${thisBlock}"`, {
						elements: [thisSelected],
					})
				})
				.catch(err => {
					if (isStale()) return
					error?.set(err.message)
				})
		}

		// effect の再実行時と component の破棄時に走る。 この run が起動した validation を無効化する。
		return invalidatePendingValidation
	})

	onDestroy(() => {
		unsubs.forEach(u => u())
	})
</script>

{#if selected}
	<p class="panel_toolbar_label label">
		{translate('panel.vanilla_block_display.title')}
	</p>

	<div
		class="toolbar custom-toolbar"
		title={translate('panel.vanilla_block_display.description')}
	>
		<div class="content" style="width: 95%;">
			<input type="text" bind:value={block} />
		</div>
	</div>

	{#if $error}
		<div class="error">
			{$error}
		</div>
	{/if}
{/if}

<style>
	input {
		background-color: var(--color-button);
		padding: 2px 8px;
		width: 100%;
	}
	.label {
		margin-bottom: -3px !important;
	}
	.custom-toolbar {
		display: flex;
		flex-direction: row;
		margin-bottom: 1px;
	}
	.custom-toolbar :global(.sp-replacer) {
		padding: 4px 18px !important;
		height: 28px !important;
		margin: 1px 0px !important;
	}
	.error {
		margin: 2px 8px;
		font-size: 14px;
		color: var(--color-error);
	}
</style>
