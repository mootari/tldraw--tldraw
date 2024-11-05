import {
	SelectionEdge,
	TLShapeId,
	canonicalizeRotation,
	getPointerInfo,
	toDomPrecision,
	useEditor,
	useIsEditing,
	useValue,
} from '@tldraw/editor'
import { useCallback, useEffect, useRef } from 'react'
import { FrameLabelInput } from './FrameLabelInput'

export const FrameHeading = function FrameHeading({
	id,
	name,
	width,
	height,
}: {
	id: TLShapeId
	name: string
	width: number
	height: number
}) {
	const editor = useEditor()
	const pageRotation = useValue(
		'shape rotation',
		() => canonicalizeRotation(editor.getShapePageTransform(id)!.rotation()),
		[editor, id]
	)

	const isEditing = useIsEditing(id)

	const rInput = useRef<HTMLInputElement>(null)

	const handlePointerDown = useCallback(
		(e: React.PointerEvent) => {
			const event = getPointerInfo(e)
			e.preventDefault()

			e.currentTarget.setPointerCapture(e.pointerId)

			// If we're editing the frame label, we shouldn't hijack the pointer event
			if (editor.getEditingShapeId() === id) return

			editor.dispatch({
				type: 'pointer',
				name: 'pointer_down',
				target: 'shape',
				shape: editor.getShape(id)!,
				...event,
			})
		},
		[editor, id]
	)

	const handlePointerUp = useCallback((e: React.PointerEvent) => {
		e.currentTarget.releasePointerCapture(e.pointerId)
	}, [])

	useEffect(() => {
		const el = rInput.current
		if (el && isEditing) {
			// On iOS, we must focus here
			el.focus()
			el.select()
		}
	}, [rInput, isEditing])

	const labelSide = getLabelSide(pageRotation)
	let labelTranslate: string
	switch (labelSide) {
		case 'top':
			labelTranslate = ``
			break
		case 'right':
			labelTranslate = `translate(${toDomPrecision(width)}px, 0px) rotate(90deg)`
			break
		case 'bottom':
			labelTranslate = `translate(${toDomPrecision(width)}px, ${toDomPrecision(
				height
			)}px) rotate(180deg)`
			break
		case 'left':
			labelTranslate = `translate(0px, ${toDomPrecision(height)}px) rotate(270deg)`
			break
	}

	return (
		<div
			className="tl-frame-heading"
			style={{
				overflow: isEditing ? 'visible' : 'hidden',
				maxWidth: `calc(var(--tl-zoom) * ${
					labelSide === 'top' || labelSide === 'bottom' ? Math.ceil(width) : Math.ceil(height)
				}px + var(--space-5))`,
				bottom: '100%',
				transform: `${labelTranslate} scale(var(--tl-scale)) translateX(calc(-1 * var(--space-3))`,
			}}
			onPointerDown={handlePointerDown}
			onPointerUp={handlePointerUp}
		>
			<div className="tl-frame-heading-hit-area">
				<FrameLabelInput ref={rInput} id={id} name={name} isEditing={isEditing} />
			</div>
		</div>
	)
}

export function getLabelSide(pageRotation: number) {
	// rotate right 45 deg
	const offsetRotation = pageRotation + Math.PI / 4
	const scaledRotation = (offsetRotation * (2 / Math.PI) + 4) % 4
	const labelSide: SelectionEdge = (['top', 'left', 'bottom', 'right'] as const)[
		Math.floor(scaledRotation)
	]
	return labelSide
}
