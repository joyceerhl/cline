import type { ToolUse } from "@core/assistant-message"
import { ClineAsk, ClineSay } from "@shared/ExtensionMessage"
import { ClineAskResponse } from "@shared/WebviewMessage"
import type { ToolResponse } from "../index"

export interface IToolHandler {
	readonly name: string
	execute(config: any, block: ToolUse): Promise<ToolResponse>
}

export interface UIHelpers {
	ask: (
		type: ClineAsk,
		text?: string,
		partial?: boolean,
	) => Promise<{
		response: ClineAskResponse
		text?: string
		images?: string[]
		files?: string[]
	}>
	say: (type: ClineSay, text?: string, images?: string[], files?: string[], partial?: boolean) => Promise<number | undefined>
	removeClosingTag: (block: ToolUse, tag: any, text?: string) => string
	removeLastPartialMessageIfExistsWithType: (type: "ask" | "say", askOrSay: any) => Promise<void>
}

export interface IPartialBlockHandler {
	handlePartialBlock(block: ToolUse, uiHelpers: UIHelpers): Promise<void>
}

/**
 * Coordinates tool execution by routing to registered handlers.
 * Falls back to legacy switch for unregistered tools.
 */
export class ToolExecutorCoordinator {
	private handlers = new Map<string, IToolHandler>()

	/**
	 * Register a tool handler
	 */
	register(handler: IToolHandler): void {
		this.handlers.set(handler.name, handler)
	}

	/**
	 * Check if a handler is registered for the given tool
	 */
	has(toolName: string): boolean {
		return this.handlers.has(toolName)
	}

	/**
	 * Get a handler for the given tool name
	 */
	getHandler(toolName: string): IToolHandler | undefined {
		return this.handlers.get(toolName)
	}

	/**
	 * Execute a tool through its registered handler
	 */
	async execute(config: any, block: ToolUse): Promise<ToolResponse> {
		const handler = this.handlers.get(block.name)
		if (!handler) {
			throw new Error(`No handler registered for tool: ${block.name}`)
		}
		return handler.execute(config, block)
	}
}
