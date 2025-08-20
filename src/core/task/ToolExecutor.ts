import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import Anthropic from "@anthropic-ai/sdk"
import { ApiHandler } from "@core/api"
import { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import { ClineIgnoreController } from "@core/ignore/ClineIgnoreController"
import { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import { extractFileContent } from "@integrations/misc/extract-file-content"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { BrowserSession } from "@services/browser/BrowserSession"
import { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import { McpHub } from "@services/mcp/McpHub"
import { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import { BrowserSettings } from "@shared/BrowserSettings"
import { COMMAND_REQ_APP_STRING } from "@shared/combineCommandSequences"
import {
	BrowserAction,
	BrowserActionResult,
	browserActions,
	ClineAsk,
	ClineAskQuestion,
	ClineAskUseMcpServer,
	ClinePlanModeResponse,
	ClineSay,
	ClineSayBrowserAction,
	ClineSayTool,
	COMPLETION_RESULT_CHANGES_FLAG,
} from "@shared/ExtensionMessage"
import { FocusChainSettings } from "@shared/FocusChainSettings"
import { Mode } from "@shared/storage/types"
import { ClineAskResponse } from "@shared/WebviewMessage"
import { fileExistsAtPath } from "@utils/fs"
import { modelDoesntSupportWebp } from "@utils/model-utils"
import { fixModelHtmlEscaping, removeInvalidChars } from "@utils/string"
import os from "os"
import * as path from "path"
import { serializeError } from "serialize-error"
import * as vscode from "vscode"
import { HostProvider } from "@/hosts/host-provider"
import { showSystemNotification } from "@/integrations/notifications"
import { listFiles } from "@/services/glob/list-files"
import { telemetryService } from "@/services/posthog/PostHogClientProvider"
import { regexSearchFiles } from "@/services/ripgrep"
import { parseSourceCodeForDefinitionsTopLevel } from "@/services/tree-sitter"
import { findLast, findLastIndex, parsePartialArrayString } from "@/shared/array"
import { createAndOpenGitHubIssue } from "@/utils/github-url-utils"
import { getReadablePath, isLocatedInWorkspace } from "@/utils/path"
import { ToolParamName, ToolUse, ToolUseName } from "../assistant-message"
import { constructNewFileContent } from "../assistant-message/diff"
import { ContextManager } from "../context/context-management/ContextManager"
import { continuationPrompt } from "../prompts/contextManagement"
import { loadMcpDocumentation } from "../prompts/loadMcpDocumentation"
import { formatResponse } from "../prompts/responses"
import { CacheService } from "../storage/CacheService"
import { ensureTaskDirectoryExists } from "../storage/disk"
import { ToolResponse } from "."
import { MessageStateHandler } from "./message-state"
import { TaskState } from "./TaskState"
import { AutoApprove } from "./tools/autoApprove"
import { ToolExecutionManager } from "./tools/ToolExecutionManager"
import { ToolDisplayUtils } from "./tools/utils/ToolDisplayUtils"
import { ToolResultUtils } from "./tools/utils/ToolResultUtils"
import { showNotificationForApprovalIfAutoApprovalEnabled } from "./utils"

export class ToolExecutor {
	private autoApprover: AutoApprove
	private executionManager: ToolExecutionManager

	// Auto-approval methods using the AutoApprove class
	private shouldAutoApproveTool(toolName: ToolUseName): boolean | [boolean, boolean] {
		return this.autoApprover.shouldAutoApproveTool(toolName)
	}

	private async shouldAutoApproveToolWithPath(
		blockname: ToolUseName,
		autoApproveActionpath: string | undefined,
	): Promise<boolean> {
		return this.autoApprover.shouldAutoApproveToolWithPath(blockname, autoApproveActionpath)
	}

	constructor(
		// Core Services & Managers
		private context: vscode.ExtensionContext,
		private taskState: TaskState,
		private messageStateHandler: MessageStateHandler,
		private api: ApiHandler,
		private urlContentFetcher: UrlContentFetcher,
		private browserSession: BrowserSession,
		private diffViewProvider: DiffViewProvider,
		private mcpHub: McpHub,
		private fileContextTracker: FileContextTracker,
		private clineIgnoreController: ClineIgnoreController,
		private contextManager: ContextManager,
		private cacheService: CacheService,

		// Configuration & Settings
		private autoApprovalSettings: AutoApprovalSettings,
		private browserSettings: BrowserSettings,
		private focusChainSettings: FocusChainSettings,
		private cwd: string,
		private taskId: string,
		private ulid: string,
		private mode: Mode,
		private strictPlanModeEnabled: boolean,

		// Callbacks to the Task (Entity)
		private say: (
			type: ClineSay,
			text?: string,
			images?: string[],
			files?: string[],
			partial?: boolean,
		) => Promise<number | undefined>,
		private ask: (
			type: ClineAsk,
			text?: string,
			partial?: boolean,
		) => Promise<{
			response: ClineAskResponse
			text?: string
			images?: string[]
			files?: string[]
		}>,
		private saveCheckpoint: (isAttemptCompletionMessage?: boolean, completionMessageTs?: number) => Promise<void>,
		private sayAndCreateMissingParamError: (toolName: ToolUseName, paramName: string, relPath?: string) => Promise<any>,
		private removeLastPartialMessageIfExistsWithType: (type: "ask" | "say", askOrSay: ClineAsk | ClineSay) => Promise<void>,
		private executeCommandTool: (command: string) => Promise<[boolean, any]>,
		private doesLatestTaskCompletionHaveNewChanges: () => Promise<boolean>,
		private updateFCListFromToolResponse: (taskProgress: string | undefined) => Promise<void>,
	) {
		this.autoApprover = new AutoApprove(autoApprovalSettings)

		// Initialize the execution manager using the factory method (handles tool registration internally)
		this.executionManager = ToolExecutionManager.create(
			this.asToolConfig(),
			this.pushToolResult,
			this.shouldAutoApproveToolWithPath.bind(this),
			this.sayAndCreateMissingParamError,
			this.removeLastPartialMessageIfExistsWithType,
			this.say,
			this.ask,
			this.askApproval,
			this.saveCheckpoint,
			this.updateFCListFromToolResponse,
			this.handleError,
		)
	}

	// Provide a minimal TaskConfig-like object for handlers. Cast to any to avoid coupling yet.
	private asToolConfig(): any /* TaskConfig */ {
		return {
			taskId: this.taskId,
			ulid: this.ulid,
			context: this.context,
			mode: this.mode,
			strictPlanModeEnabled: this.strictPlanModeEnabled,
			cwd: this.cwd,
			taskState: this.taskState,
			messageState: this.messageStateHandler,
			api: this.api,
			autoApprovalSettings: this.autoApprovalSettings,
			autoApprover: this.autoApprover,
			browserSettings: this.browserSettings,
			focusChainSettings: this.focusChainSettings,
			services: {
				mcpHub: this.mcpHub,
				browserSession: this.browserSession,
				urlContentFetcher: this.urlContentFetcher,
				diffViewProvider: this.diffViewProvider,
				fileContextTracker: this.fileContextTracker,
				clineIgnoreController: this.clineIgnoreController,
				contextManager: this.contextManager,
				cacheService: this.cacheService,
				// terminalManager not used by file/list/search handlers; omit for now
			},
			callbacks: {
				say: this.say,
				ask: this.ask,
				askApproval: this.askApproval,
				saveCheckpoint: this.saveCheckpoint,
				postStateToWebview: async () => {},
				reinitExistingTaskFromId: async () => {},
				cancelTask: async () => {},
				updateTaskHistory: async (_: any) => [],
				executeCommandTool: this.executeCommandTool,
				doesLatestTaskCompletionHaveNewChanges: this.doesLatestTaskCompletionHaveNewChanges,
				updateFCListFromToolResponse: this.updateFCListFromToolResponse,
				sayAndCreateMissingParamError: this.sayAndCreateMissingParamError,
				removeLastPartialMessageIfExistsWithType: this.removeLastPartialMessageIfExistsWithType,
				shouldAutoApproveToolWithPath: this.shouldAutoApproveToolWithPath.bind(this),
			},
		} as any
	}

	/**
	 * Updates the auto approval settings
	 */
	public updateAutoApprovalSettings(settings: AutoApprovalSettings): void {
		this.autoApprover.updateSettings(settings)
	}

	public updateMode(mode: Mode): void {
		this.mode = mode
		// Update the mode in the config object that's passed to ToolExecutionManager
		if (this.executionManager) {
			const config = this.asToolConfig()
			;(this.executionManager as any).config = config
		}
	}

	public updateStrictPlanModeEnabled(strictPlanModeEnabled: boolean): void {
		this.strictPlanModeEnabled = strictPlanModeEnabled
		// Update the strictPlanModeEnabled in the config object
		if (this.executionManager) {
			const config = this.asToolConfig()
			;(this.executionManager as any).config = config
		}
	}

	/**
	 * Main entry point for tool execution - called by Task class
	 */
	public async executeTool(block: ToolUse): Promise<void> {
		await this.executionManager.execute(block)
	}

	/**
	 * Handles approval requests for tools
	 */
	private async askApproval(type: ClineAsk, block: ToolUse, message: string): Promise<boolean> {
		const { response } = await this.ask(type, message)
		return response === "yesButtonClicked"
	}

	/**
	 * Handles errors during tool execution
	 */
	private async handleError(action: string, error: Error, block: ToolUse): Promise<void> {
		const errorString = `Error ${action}: ${error.message}`
		await this.say("error", errorString)

		// Create error response for the tool
		const errorResponse = formatResponse.toolError(errorString)
		this.pushToolResult(errorResponse, block)
	}

	private pushToolResult = (content: ToolResponse, block: ToolUse) => {
		// This method is called by the ToolExecutionManager to push results back to the Task
		// Use the ToolResultUtils to properly format and push the tool result
		ToolResultUtils.pushToolResult(
			content,
			block,
			this.taskState.userMessageContent,
			(block: ToolUse) => ToolDisplayUtils.getToolDisplayName(block),
			this.api,
			() => {
				this.taskState.didAlreadyUseTool = true
			},
		)
	}
}
