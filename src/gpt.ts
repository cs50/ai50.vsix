/* eslint-disable @typescript-eslint/naming-convention */

import * as vscode from 'vscode';
import { encode, decode, codeBlock } from './utils';
import { createWebviewPanel, webviewDeltaUpdate, disposeWebview } from './webview';
const { Configuration, OpenAIApi } = require("openai");

let openai: any;
let configuration: any;
let _context: vscode.ExtensionContext;
let didSetApiKey: boolean = false;

async function init(context: vscode.ExtensionContext) {

    // Set vscode context
    _context = context;

    // Retrieve API key from global state, if it exists
    const storedApiKey = context.globalState.get('copilot50.apiKey');
    storedApiKey !== undefined ? setApiKey(decode(String(storedApiKey))) : null;
}

async function moderatePrompt(prompt: string) {
    const response = await openai.createModeration(
        { input: prompt, model: 'text-moderation-latest' });
    const flagged = Boolean(response.data.results[0].flagged);
    if (flagged) {
        const message = 'Prompt contains inappropriate content and was flagged by OpenAI';
        console.error(message);
        console.error(response.data);
        vscode.window.showErrorMessage(message);
        throw new Error(message);
    }
}

async function processPrompt(languageId: string, codeSnippet: string, documentName: string, lineStart: number, lineEnd: number) {
    if (!didSetApiKey) {
        await requestApiKey().catch((err) => {
            errorHandling(err);
        });
    }

    if (didSetApiKey) {
        let panelId = createWebviewPanel(_context, documentName, lineStart, lineEnd);
        const prompt = buildPrompt(languageId, codeSnippet);
        try {

            // Check if prompt contains inappropriate content
            await moderatePrompt(prompt);
            const systemContext = 'You are a software engineer. Your goal is to explain a code snippet to a student. Please do not complete any codes or provide solutions. Explain the code in plain English using correct terminology, grammar, and punctuation. Offer examples as needed, but they are not required.';

            const response = await openai.createChatCompletion(
                {
                    model: 'gpt-3.5-turbo',
                    messages: [
                        // https://learn.microsoft.com/en-us/azure/cognitive-services/openai/how-to/chatgpt?pivots=programming-language-chat-completions#system-role
                        { role: 'system', content: systemContext },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0,
                    stream: true
                },
                { responseType: 'stream' });

            // Stream response data
            // https://platform.openai.com/docs/api-reference/chat/create#chat/create-stream
            // https://github.com/openai/openai-node/issues/18#issuecomment-1369996933
            let buffers: string = '';
            response.data.on('data', (data: { toString: () => string; }) => {

                // Split stream data into lines and filter out empty lines
                const lines = data.toString().split('\n').filter((line: string) => line.trim() !== '');

                // Process each line of stream data
                for (const line of lines) {

                    // Strip 'data: ' prefix from line
                    const message = line.replace(/^data: /, '');

                    // Stream finished, perform final delta update
                    if (message === '[DONE]') {
                        webviewDeltaUpdate(panelId, codeBlock(languageId, codeSnippet) + buffers);
                        return;
                    }

                    // Parse JSON message, extract content and update buffer
                    try {
                        const content = JSON.parse(message).choices[0].delta.content;
                        content !== undefined ? buffers += content : null;
                    } catch (error) {
                        console.error('Could not JSON parse stream message', message, error);
                    }
                }

                // Delta update webview panel with new buffer content
                webviewDeltaUpdate(panelId, codeBlock(languageId, codeSnippet) + buffers);
            });
        } catch (error: any) {
            errorHandling(error);
        }
    }
}

// Prompt engineering, sets the context for the GPT model to generate a response.
function buildPrompt(languageId: string, codeSnippet: string) {

    // Tell the model what kind of code snippet it is
    const task = `Explain this ${languageId} programming language code snippet.`;
    const start = '--- Code snippet begins ---';
    const end = '--- Code snippet ends ---';

    // Build prompt
    const prompt =
        `${task}.\n` +
        `${start}\n${codeSnippet.trim()}\n${end}\n`

    return prompt;
}

// Prompt user to enter api key via vscode popup
async function requestApiKey() {
    await vscode.window.showInputBox({
        prompt: 'Please enter your OpenAI API key',
        placeHolder: 'sk-',
        ignoreFocusOut: true,
    }).then((value) => {
        if (value) {
            setApiKey(value);
            vscode.window.showInformationMessage("API key set successfully");
        } else {
            throw new Error('No API key provided');
        }
    });
}

// Set API key in global state
function setApiKey(value: string) {
    try {
        configuration = new Configuration({
            apiKey: value,
        });
        openai = new OpenAIApi(configuration);
        _context.globalState.update('copilot50.apiKey', encode(value.trim()));
        didSetApiKey = true;
    } catch (e) {
        console.log(e);
        vscode.window.showErrorMessage(`Failed to set API key: ${e}`);
    }
}

// Remove API key from global state and unset it
function unsetApiKey() {
    if (didSetApiKey) {
        _context.globalState.update('copilot50.apiKey', undefined);
        didSetApiKey = false;
        vscode.window.showInformationMessage("API key removed");
    } else {
        vscode.window.showWarningMessage("API key not found");
    }
}

function errorHandling(error: any) {
    try {
        if (error.response?.status) {
            console.error(error.response.status, error.message);

            if (error.response.status === 401) {
                vscode.window.showErrorMessage('Invalid OpenAI API key');
                unsetApiKey();
                return;
            }

            error.response.data.on('data', (data: { toString: () => any; }) => {
                const message = data.toString();
                try {
                    const parsed = JSON.parse(message);
                    vscode.window.showErrorMessage('An error occurred during OpenAI request: ' + parsed.error.message);
                    console.error('An error occurred during OpenAI request: ', parsed);
                } catch(error) {
                    vscode.window.showErrorMessage('An error occurred during OpenAI request: ' + message);
                    console.error('An error occurred during OpenAI request: ', message);
                }
            });
        } else {
            vscode.window.showErrorMessage('An error occurred during OpenAI request, please check the console for more details');
            console.error('An error occurred during OpenAI request', error);
        }
    }
    catch (e) {
        console.log(e);
        vscode.window.showErrorMessage(`Unknown error occurred: ${e}`);
    }
    finally {
        disposeWebview();
    }
}

export { init, processPrompt, requestApiKey, unsetApiKey };
