import {
	TLDefaultFillStyle,
	TLDefaultFontStyle,
	TLDefaultHorizontalAlignStyle,
	TLDefaultVerticalAlignStyle,
	TLShapeId,
} from '@tldraw/tlschema'
import React from 'react'
import { MeasureMethod } from '../../editor/managers/TextManager'
import { Box } from '../../primitives/Box'

/**
 * @public
 * This is an _experimental_ component that we are still exploring.
 */
export type TLTextTriggerHook = (
	inputEl: HTMLTextAreaElement | null,
	onComplete: (text: string) => void
) => {
	onKeyDown: (
		e: React.KeyboardEvent<HTMLTextAreaElement>,
		coords: {
			top: number
			left: number
		}
	) => Promise<boolean>
}

/** @public */
export interface TextLabelProps {
	id: TLShapeId
	type: string
	font: TLDefaultFontStyle
	fontSize: number
	lineHeight: number
	fill?: TLDefaultFillStyle
	align: TLDefaultHorizontalAlignStyle
	verticalAlign: TLDefaultVerticalAlignStyle
	wrap?: boolean
	text: string
	labelColor: string
	bounds?: Box
	isNote?: boolean
	isSelected: boolean
	disableTab?: boolean
	onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
	classNamePrefix?: string
	style?: React.CSSProperties
	textWidth?: number
	textHeight?: number
	useTextTriggerCharacter?: TLTextTriggerHook
	padding?: number
}

/** @public */
export type ITextLabel<P> = React.NamedExoticComponent<P> & {
	measureMethod?: MeasureMethod
}

/**
 * @public
 * This is an _experimental_ component that we are still exploring.
 */
export type TLTextLabel = ITextLabel<TextLabelProps>

/**
 * @public @react
 * This is an _experimental_ component that we are still exploring.
 */
export const DefaultTextLabel: TLTextLabel = React.memo(function DefaultTextLabel({ text }) {
	return (
		<div className="tl-text-label tl-text-wrapper">
			<div className="tl-text tl-text-content" dir="ltr">
				{text}
			</div>
		</div>
	)
})
DefaultTextLabel.measureMethod = 'text'
