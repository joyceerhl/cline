import { telemetryService } from "@services/posthog/PostHogClientProvider"
import { findLast, parsePartialArrayString } from "@shared/array"
import { ClineAskQuestion } from "@shared/ExtensionMessage"
import { ToolUse, ToolUseName } from "../../../assistant-message"
import { formatResponse } from "../../../prompts/responses"
import { ToolResponse } from "../.."
import type { IToolHandler } from "../ToolExecutorCoordinator"
import { ToolResultUtils } from "../utils/ToolResultUtils"

export class AskFollowupQuestionToolHandler implements IToolHandler {
	name = "ask_followup_question"
	supportedTools: ToolUseName[] = ["ask_followup_question"]

	async execute(config: any, block: ToolUse): Promise<ToolResponse> {
		const question: string | undefined = block.params.question
		const optionsRaw: string | undefined = block.params.options

		// Validate required parameter
		if (!question) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError("ask_followup_question", "question")
		}
		config.taskState.consecutiveMistakeCount = 0

		const sharedMessage = {
			question: question,
			options: parsePartialArrayString(optionsRaw || "[]"),
		} satisfies ClineAskQuestion

		const options = parsePartialArrayString(optionsRaw || "[]")

		// Ask the question
		const {
			text,
			images,
			files: followupFiles,
		} = await config.callbacks.ask("followup", JSON.stringify(sharedMessage), false)

		// Check if options contains the text response
		if (optionsRaw && text && options.includes(text)) {
			telemetryService.captureOptionSelected(config.ulid, options.length, "act")

			// Valid option selected, update last followup message with selected option
			const clineMessages = config.messageState.getClineMessages()
			const lastFollowupMessage = findLast(clineMessages, (m: any) => m.ask === "followup")
			if (lastFollowupMessage) {
				lastFollowupMessage.text = JSON.stringify({
					...sharedMessage,
					selected: text,
				} satisfies ClineAskQuestion)
				await config.messageState.saveClineMessagesAndUpdateHistory()
			}
		} else {
			// Option not selected, send user feedback
			telemetryService.captureOptionsIgnored(config.ulid, options.length, "act")
			await config.callbacks.say("user_feedback", text ?? "", images, followupFiles)
		}

		// Process any attached files
		const fileContentString = await ToolResultUtils.processFilesForFeedback(followupFiles)

		return formatResponse.toolResult(`<answer>\n${text}\n</answer>`, images, fileContentString)
	}
}
