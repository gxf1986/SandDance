// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.
'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as azdata from 'azdata';
import * as tempWrite from 'temp-write';
import { getWebviewContent } from './html';
import { MssqlExtensionApi, IFileNode } from './mssqlapis';

interface WebViewWithUri {
    panel: vscode.WebviewPanel;
    uriFsPath: string;
}
let current: WebViewWithUri | undefined = undefined;

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('sandance.view', (commandContext: vscode.Uri | azdata.ObjectExplorerContext) => {
            if (!commandContext) {
                vscode.window.showErrorMessage('No file was specified for the View in Sandance command');
                return;
            }
            if (commandContext instanceof vscode.Uri) {
                viewInSandance(<vscode.Uri>commandContext, context);
            } else if (commandContext.nodeInfo) {
                // This is a call from the object explorer right-click.
                downloadAndViewInSandance(commandContext, context);
            }
        }
        )
    );

    //To do: replace regiserCommand with suubscription.push
    vscode.commands.registerCommand('query.sanddance', () => {
        azdata.queryeditor.registerQueryEventListener({
            async onQueryEvent(type: azdata.queryeditor.QueryEvent, document: azdata.queryeditor.QueryDocument, args: any) {
                if (type === 'visualize') {
                    const providerid = document.providerId;
                    let provider: azdata.QueryProvider;
                    provider = azdata.dataprotocol.getProvider(providerid, azdata.DataProviderType.QueryProvider);
                    let data = await provider.getQueryRows({
                        ownerUri: document.uri,
                        batchIndex: args.batchId,
                        resultSetIndex: args.id,
                        rowsStartIndex: 0,
                        rowsCount: args.rowCount
                    });

                    // TODO get columns and rows data from data
                    let columns = data.columnInfo;
                    let rows = data.rows;

                    // Create csv 
                    let csv = "";

                    // Add column names to csv
                    for (let i = 0; i < columns.length - 1; i++ ) {
                        csv = csv + columns[i].columnName + ",";
                    }
                    csv = csv + columns[columns.length-1].columnName + "\n";

                    // Add row information, adding if displayValue is not null
                    for (let i = 0; i < rows.length; i++ ){ 
                        let row = rows[i];

                        for (let j = 0; j < row.length-1; j++ ) {
                            if (!row[j].isNull) {
                                csv = csv + row[j].displayValue + ",";
                            } else {
                                csv = csv + " ,";
                            }
                        }

                        if (!row[row.length-1].isNull) {
                            csv = csv + row[row.length-1].displayValue + "\n";
                        } else {
                            csv = csv + " \n";
                        }
                    }     
                    //let datavalue = data.resultSubset.rows;
                    let fileuri = saveTemp(csv);
                    queryViewInSandance(fileuri, context, document);
                }
            }
        });
    });
}

async function downloadAndViewInSandance(commandContext: azdata.ObjectExplorerContext, context: vscode.ExtensionContext): Promise<void> {
    try {
        let fileUri = await saveHdfsFileToTempLocation(commandContext);
        if (fileUri) {
            viewInSandance(fileUri, context);
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Error viewing in Sandance: ${error.message ? error.message : error}`);
    }
}

function viewInSandance(fileUri: vscode.Uri, context: vscode.ExtensionContext): void {
    const columnToShowIn = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;
    const uriFsPath = fileUri.fsPath;
    //only allow one SandDance at a time
    if (current && current.uriFsPath !== uriFsPath) {
        current.panel.dispose();
        current = undefined;
    }
    if (current) {
        //TODO: registerWebviewPanelSerializer to hydrate state
        // If we already have a panel, show it in the target column
        current.panel.reveal(columnToShowIn);
    }
    else {
        // Otherwise, create a new panel
        current = newPanel(context, uriFsPath);
        current.panel.onDidDispose(() => {
            current = undefined;
        }, null, context.subscriptions);
        // Handle messages from the webview
        current.panel.webview.onDidReceiveMessage(message => {
            switch (message.command) {
                case 'getFileContent':
                    fs.readFile(uriFsPath, (err, data) => {
                        if (current && current.panel.visible) {
                            //TODO string type of dataFile
                            const dataFile = {
                                type: path.extname(uriFsPath).substring(1),
                                rawText: data.toString('utf8')
                            };
                            current.panel.webview.postMessage({ command: 'gotFileContent', dataFile });
                        }
                    });
                    break;
            }
        }, undefined, context.subscriptions);
    }
}

// View in SandDance for SQL query editor
function queryViewInSandance(fileUri: vscode.Uri, context: vscode.ExtensionContext, editorUri: azdata.queryeditor.QueryDocument): void {
    const columnToShowIn = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;
    const uriFsPath = fileUri.fsPath;
    //only allow one SandDance at a time
    if (current && current.uriFsPath !== uriFsPath) {
        current.panel.dispose();
        current = undefined;
    }
    if (current) {
        //TODO: registerWebviewPanelSerializer to hydrate state
        // If we already have a panel, show it in the target column
        current.panel.reveal(columnToShowIn);
    }
    else {
        // Otherwise, create a new panel
        const uriTabName = editorUri.uri;
        current = newPanelQuery(context, uriFsPath, uriTabName);
        current.panel.onDidDispose(() => {
            current = undefined;
        }, null, context.subscriptions);
        // Handle messages from the webview
        current.panel.webview.onDidReceiveMessage(message => {
            switch (message.command) {
                case 'getFileContent':
                    fs.readFile(uriFsPath, (err, data) => {
                        if (current && current.panel.visible) {
                            //TODO string type of dataFile
                            const dataFile = {
                                type: path.extname(uriFsPath).substring(1),
                                rawText: data.toString('utf8')
                            };
                            current.panel.webview.postMessage({ command: 'gotFileContent', dataFile });
                        }
                    });
                    break;
            }
        }, undefined, context.subscriptions);
    }
}


export async function saveHdfsFileToTempLocation(commandContext: azdata.ObjectExplorerContext): Promise<vscode.Uri | undefined> {
    let extension = vscode.extensions.getExtension('Microsoft.mssql');
    if (!extension) {
        return undefined;
    }
    let extensionApi: MssqlExtensionApi = extension.exports;
    let browser = extensionApi.getMssqlObjectExplorerBrowser();
    let node: IFileNode = await browser.getNode<IFileNode>(commandContext);
    let contents = await node.getFileContentsAsString();
    if (contents !== undefined) {
        let localFile = tempWrite.sync(contents, node.getNodeInfo().label);
        return vscode.Uri.file(localFile);
    }   // else ignore for now
    return undefined;
}


function saveTemp(data: azdata.DbCellValue[][]): vscode.Uri {
    let localFile = tempWrite.sync(JSON.stringify(data), undefined);
    return vscode.Uri.file(localFile);
}


export function deactivate() {
}

function newPanel(context: vscode.ExtensionContext, uriFsPath: string) {
    const webViewWithUri: WebViewWithUri = {
        panel: vscode.window.createWebviewPanel(
            'sandDance',
            `SandDance: ${path.basename(uriFsPath)}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                // Only allow the webview to access resources in our extension's media directory
                localResourceRoots: [
                    vscode.Uri.file(path.join(context.extensionPath, 'resources'))
                ],
                retainContextWhenHidden: true
            }
        ),
        uriFsPath
    };
    webViewWithUri.panel.webview.html = getWebviewContent(context.extensionPath, uriFsPath);
    return webViewWithUri;
}

function newPanelQuery(context: vscode.ExtensionContext, uriFsPath: string, uriTabName: string) {
    const webViewWithUri: WebViewWithUri = {
        panel: vscode.window.createWebviewPanel(
            'sandDance',
            `SandDance: ${path.basename(uriTabName)}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                // Only allow the webview to access resources in our extension's media directory
                localResourceRoots: [
                    vscode.Uri.file(path.join(context.extensionPath, 'resources'))
                ],
                retainContextWhenHidden: true
            }
        ),
        uriFsPath
    };
    webViewWithUri.panel.webview.html = getWebviewContent(context.extensionPath, uriFsPath);
    return webViewWithUri;
}