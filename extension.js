const OpenAI = require("openai");
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const simpleGit = require("simple-git");
const dotenv = require("dotenv");
let globalFetch;
let timerInterval;
let autoCommitMode = false;

// Armazena a última versão conhecida do conteúdo dos arquivos
let lastFileContent = {};

// Teste
let commitIntervalMinutes = 60; // Em minutos (converteremos para ms na configuração)

// Carregar as variáveis do .env
const envPath = path.join(__dirname, "process.env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const hfAPIToken = process.env.HF_API_TOKEN;

/**
 * Função de ativação da extensão
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
  // Importa o módulo de fetch
  const fetchModule = await import("node-fetch");
  globalFetch = fetchModule.default;

  // Comando para iniciar a extensão
  const startDisposable = vscode.commands.registerCommand(
    "auto-log.start",
    async () => {
      // Limpa o timer existente, se houver
      if (timerInterval) {
        clearInterval(timerInterval);
      }

      const login = await getUserLogin(context);
      if (!login) return false;
      const { username, token } = login;
      vscode.window.showInformationMessage(
        `User Logado: ${username}\nToken Pessoal: ${token}`
      );

      // Solicita o intervalo de commits com validação aprimorada
      const intervalInput = await vscode.window.showInputBox({
        prompt:
          "Defina intervalo de commits (minutos) (apenas números inteiros positivos)",
        value: "60",
      });
      let minutes = parseInt(intervalInput);
      if (isNaN(minutes) || minutes <= 0) {
        vscode.window.showWarningMessage(
          "Intervalo inválido. Usando 60 minutos."
        );
        minutes = 60;
      }
      // Converte minutos para milissegundos
      commitIntervalMinutes = minutes * 60000;
      vscode.window.showInformationMessage(
        `Commits automáticos a cada ${minutes} minutos`
      );

      // Define o intervalo para executar a tarefa de commit
      timerInterval = setInterval(
        () => commitTask(context),
        commitIntervalMinutes
      );
    }
  );
  registerCommandContext(context, startDisposable);

  // Comando para alternar o modo de commit automático
  const toggleDisposable = vscode.commands.registerCommand(
    "auto-log.toggleAutoCommitMode",
    async () => {
      autoCommitMode = !autoCommitMode;
      vscode.window.showInformationMessage(
        `Modo de commit automático ${
          autoCommitMode ? "ativado" : "desativado"
        }.`
      );
    }
  );
  registerCommandContext(context, toggleDisposable);

  // Comando para exibir o histórico de commits
  const historyCommand = vscode.commands.registerCommand(
    "auto-log.history",
    async () => {
      await showCommitHistory(context);
    }
  );
  registerCommandContext(context, historyCommand);

  // Comando para exportar os logs para CSV
  const exportCSV = vscode.commands.registerCommand(
    "auto-log.exportLogs",
    async () => {
      await exportCommitLogsToCSV(context);
    }
  );
  registerCommandContext(context, exportCSV);
}

/**
 * Registra os comandos no contexto da extensão
 * @param {vscode.ExtensionContext} context
 * @param {*} command
 */
function registerCommandContext(context, command) {
  context.subscriptions.push(command);
}

/**
 * Gera um diff simples entre dois textos, linha a linha.
 * Linhas adicionadas são prefixadas com "+ " e removidas com "- ".
 * @param {string} oldStr - Conteúdo anterior
 * @param {string} newStr - Conteúdo atual
 * @returns {string} - Diferenças encontradas
 */
function generateDiff(oldStr, newStr) {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  let diff = "";
  const maxLength = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLength; i++) {
    const oldLine = oldLines[i] || "";
    const newLine = newLines[i] || "";
    if (oldLine !== newLine) {
      if (newLine) {
        diff += `+ ${newLine}\n`;
      }
      if (oldLine) {
        diff += `- ${oldLine}\n`;
      }
    }
  }
  return diff || "Nenhuma diferença encontrada.";
}

/**
 * Obtém as diferenças (diff) do repositório Git utilizando simple-git.
 * Caso o diretório não seja um repositório Git, verifica as alterações apenas
 * no arquivo atualmente aberto no VS Code que foi modificado nos últimos X minutos,
 * comparando o conteúdo atual com a última versão conhecida.
 */
async function getDiff() {
  const git = simpleGit();
  let isRepo = false;
  try {
    isRepo = await git.checkIsRepo();
  } catch (error) {
    console.error("Erro ao verificar repositório Git:", error);
  }

  if (isRepo) {
    // Se for um repositório Git, usa o diff do Git
    let stagedDiff;
    try {
      stagedDiff = await git.diff(["--staged"]);
    } catch (error) {
      console.error("Erro ao obter diff staged:", error);
      throw new Error("Não foi possível capturar mudanças staged no código");
    }
    const includeUnstaged = vscode.workspace
      .getConfiguration("autoLog")
      .get("includeUnstaged", false);
    if (includeUnstaged) {
      let unstagedDiff;
      try {
        unstagedDiff = await git.diff();
      } catch (error) {
        console.error("Erro ao obter diff unstaged:", error);
        throw new Error(
          "Não foi possível capturar mudanças unstaged no código"
        );
      }
      return stagedDiff + "\n" + unstagedDiff;
    }
    return stagedDiff;
  } else {
    // Caso não seja um repositório Git, verifica as alterações no arquivo aberto no VS Code.
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error("Nenhum arquivo aberto no VS Code.");
    }
    const filePath = editor.document.uri.fsPath;
    let currentContent;
    try {
      currentContent = await fs.promises.readFile(filePath, "utf8");
    } catch (err) {
      console.error("Erro ao ler o arquivo: ", err);
      throw err;
    }
    const stats = await fs.promises.stat(filePath);
    const thresholdTime = Date.now() - commitIntervalMinutes;
    if (stats.mtimeMs < thresholdTime) {
      console.warn("Nenhuma modificação detectada no arquivo aberto.");
      return "";
    }
    let diff = "";
    if (!lastFileContent[filePath]) {
      // Primeira vez: considera todo o conteúdo como alteração (pode ser ajustado conforme a necessidade)
      diff = currentContent;
    } else {
      // Gera o diff entre a versão anterior e a atual
      diff = generateDiff(lastFileContent[filePath], currentContent);
    }
    // Atualiza a snapshot do arquivo
    lastFileContent[filePath] = currentContent;
    return `Arquivo: ${filePath}\nDiferenças:\n${diff}\n`;
  }
}

/**
 * Gera mensagem de commit utilizando IA.
 * Obtém o token da Hugging Face via configuração da extensão.
 * @param {string} changes
 */
async function AIcommitMessage(changes) {
  const prompt = `Baseado nessas mudanças de código: ${changes}. Crie uma mensagem de commit para github. ESCREVA APENAS A MENSAGEM. 1 LINHA. MAXIMO DE 100 CARACTERES.`;

  var hfToken;
  try {
    var genTxt;
    hfToken = hfAPIToken;
    if (!hfToken) {
      hfToken = vscode.workspace.getConfiguration("autoLog").get("hfAPIToken");
    }
    vscode.window.showInformationMessage("Token: " + hfToken);
    const token = hfToken;
    const URL = "https://models.inference.ai.azure.com";
    const model = "gpt-4o";

    const client = new OpenAI({ baseURL: URL, apiKey: token });

    const response = await client.chat.completions.create({
      messages: [
        { role: "system", content: "You are a helpful developer assistant" },
        {
          role: "developer",
          content: prompt,
        },
      ],
      temperature: 1.0,
      top_p: 1.0,
      max_tokens: 1000,
      model: model,
    });

    genTxt = response.choices[0].message.content;

    const fallbackMessage = `update realizado em ${new Date().toLocaleString()}`;

    return genTxt || fallbackMessage;
  } catch (error) {
    console.error("Erro na geração da mensagem por IA:", error);
    vscode.window.showErrorMessage(
      `Erro na geração da mensagem: ${error.message}`
    );
    const fallbackMessage = `Auto commit realizado em ${new Date().toLocaleString()} (fallback)`;
    return fallbackMessage;
  }
}

/**
 * Realiza a autenticação do usuário via OAuth ou login manual,
 * utilizando o Secret Storage para armazenar as credenciais.
 */
async function getUserLogin(context) {
  try {
    const session = await vscode.authentication.getSession("github", ["repo"], {
      createIfNone: true,
    });
    const username = session.account.label;
    const token = session.accessToken;
    return { username, token };
  } catch (error) {
    // Tenta recuperar credenciais armazenadas de login manual
    const storedUser = await context.secrets.get("githubUser");
    const storedToken = await context.secrets.get("githubToken");
    if (storedUser && storedToken) {
      return { username: storedUser, token: storedToken };
    }
    vscode.window.showErrorMessage(`Erro ao fazer login: ${error}`);
    return await manualLogin(context);
  }
}

/**
 * Login manual caso a autenticação OAuth não funcione.
 * As credenciais são armazenadas no Secret Storage.
 */
async function manualLogin(context) {
  const username = await vscode.window.showInputBox({
    prompt: "User do Github:",
  });
  const token = await vscode.window.showInputBox({
    prompt: "Token do Github:",
    password: true,
  });
  if (!username || !token) {
    vscode.window.showErrorMessage("User ou Token inválidos.");
    return false;
  }
  await context.secrets.store("githubUser", username);
  await context.secrets.store("githubToken", token);
  return { username, token };
}

/**
 * Verifica se o repositório está na branch "main" ou "master".
 * Se não estiver, pergunta ao usuário se deseja continuar.
 * @param {string} username
 * @param {string} token
 */
async function checkBranch(username, token) {
  const repoName = vscode.workspace
    .getConfiguration("autoLog")
    .get("repositoryName", "auto-log");
  const repoUrl = `https://api.github.com/repos/${username}/${repoName}`;
  try {
    const repoResponse = await globalFetch(repoUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // Se o repositório não existir, continua
    if (!repoResponse.ok) return true;
    const repoData = await repoResponse.json();
    const defaultBranch = repoData.default_branch;
    if (defaultBranch !== "main" && defaultBranch !== "master") {
      const choice = await vscode.window.showWarningMessage(
        `Você está na branch "${defaultBranch}", que não é "main" nem "master". Deseja continuar?`,
        "Sim",
        "Não"
      );
      if (choice !== "Sim") {
        return false;
      }
    }
    return true;
  } catch (error) {
    console.error("Erro ao verificar a branch:", error);
    vscode.window.showErrorMessage(
      `Erro ao verificar a branch: ${error.message}`
    );
    return false;
  }
}

/**
 * Realiza o commit automático ou manual.
 * @param {vscode.ExtensionContext} context
 */
async function commitTask(context) {
  const login = await getUserLogin(context);
  if (!login) return;
  const { username, token } = login;

  try {
    const securityBranch = await checkBranch(username, token);
    if (!securityBranch) return false;
    vscode.window.showInformationMessage("Segurança de Branch ✅");
  } catch (error) {
    console.error("Erro na verificação da branch de segurança:", error);
    vscode.window.showErrorMessage(
      `Erro ao verificar segurança da Branch: ${error.message}`
    );
    return false;
  }

  let changes = "";
  try {
    changes = await getDiff();
  } catch (error) {
    console.error("Erro ao obter diff:", error);
    vscode.window.showErrorMessage(error.message);
    return;
  }

  if (!changes) {
    vscode.window.showInformationMessage(
      "Nenhuma mudança detectada para commit."
    );
    return;
  }

  let commitMessage = "";
  try {
    if (autoCommitMode) {
      commitMessage = await AIcommitMessage(changes);
    } else {
      commitMessage = await vscode.window.showInputBox({
        prompt: "Mensagem de Commit:",
      });
    }
    if (!commitMessage || commitMessage === "") {
      vscode.window.showErrorMessage("Nenhuma mensagem inserida");
      return;
    }
  } catch (error) {
    console.error("Erro ao criar a mensagem de commit:", error);
    vscode.window.showErrorMessage(
      `Erro ao criar a mensagem de commit: ${error.message}`
    );
    return false;
  }

  // Prepara o arquivo de log para o commit (agora consolidado em "commit_log.txt")
  const filePath = "commit_log.txt";
  const repoName = vscode.workspace
    .getConfiguration("autoLog")
    .get("repositoryName", "auto-log");
  const url = `https://api.github.com/repos/${username}/${repoName}/contents/${filePath}`;
  let sha = null;
  let existingContent = "";

  try {
    const checkResponse = await globalFetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (checkResponse.ok) {
      const fileData = await checkResponse.json();
      sha = fileData.sha;
      existingContent = Buffer.from(fileData.content, "base64").toString(
        "utf-8"
      );
    }
  } catch (error) {
    console.error("Erro ao acessar o log existente:", error);
    vscode.window.showErrorMessage(
      `Erro ao acessar o log existente: ${error.message}`
    );
    return false;
  }

  const newContent = `${existingContent}\n[${new Date().toISOString()}]\n\n${commitMessage}`;
  const contentEncoded = Buffer.from(newContent).toString("base64");
  const bodyData = {
    message: commitMessage,
    content: contentEncoded,
    ...(sha && { sha }),
  };

  try {
    const response = await globalFetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyData),
    });

    if (response.ok) {
      vscode.window.showInformationMessage(
        `Commit realizado: ${commitMessage}`
      );
    } else {
      const errorData = await response.json();
      console.error("Erro na resposta do commit:", errorData);
      throw new Error(errorData.message || "Erro ao criar commit [jsx121]");
    }
  } catch (error) {
    console.error("Erro ao realizar commit:", error);
    vscode.window.showErrorMessage(`Erro no commit [jsx105]: ${error.message}`);
  }
}

/**
 * Exibe o histórico de commits.
 * @param {vscode.ExtensionContext} context
 */
async function showCommitHistory(context) {
  const login = await getUserLogin(context);
  if (!login) return;
  const { username, token } = login;

  const repoName = vscode.workspace
    .getConfiguration("autoLog")
    .get("repositoryName", "auto-log");
  const url = `https://api.github.com/repos/${username}/${repoName}/commits`;

  try {
    const response = await globalFetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok)
      throw new Error(`Erro ao buscar histórico: ${response.statusText}`);

    const commits = await response.json();
    if (commits.length === 0) {
      vscode.window.showInformationMessage("Nenhum commit encontrado.");
      return;
    }

    let logMessage = "📜 Histórico de Commits:\n\n";
    commits.forEach((commit) => {
      logMessage += `🔹 ${commit.commit.author.date} - ${commit.commit.message} (por ${commit.commit.author.name})\n`;
    });

    vscode.window.showInformationMessage(logMessage, { modal: true });
  } catch (err) {
    console.error("Erro ao obter histórico de commits:", err);
    vscode.window.showErrorMessage(`Erro ao obter commits: ${err.message}`);
  }
}

/**
 * Exporta o histórico de commits para um arquivo CSV.
 * @param {vscode.ExtensionContext} context
 */
async function exportCommitLogsToCSV(context) {
  const login = await getUserLogin(context);
  if (!login) return;
  const { username, token } = login;

  const repoName = vscode.workspace
    .getConfiguration("autoLog")
    .get("repositoryName", "auto-log");
  const url = `https://api.github.com/repos/${username}/${repoName}/commits`;

  try {
    const response = await globalFetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok)
      throw new Error(`Erro ao buscar histórico: ${response.statusText}`);

    const commits = await response.json();
    if (commits.length === 0) {
      vscode.window.showInformationMessage(
        "Nenhum commit encontrado para exportação."
      );
      return;
    }

    let csvContent = "Data,Autor,Mensagem\n";
    commits.forEach((commit) => {
      csvContent += `"${commit.commit.author.date}","${commit.commit.author.name}","${commit.commit.message}"\n`;
    });

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage("Nenhuma pasta aberta no VS Code.");
      return;
    }

    const filePath = path.join(
      workspaceFolders[0].uri.fsPath,
      "commit_logs.csv"
    );
    await fs.promises.writeFile(filePath, csvContent, "utf8");
    vscode.window.showInformationMessage(
      `Histórico exportado para: ${filePath}`
    );
  } catch (err) {
    console.error("Erro ao exportar commits para CSV:", err);
    vscode.window.showErrorMessage(`Erro ao exportar commits: ${err.message}`);
  }
}

/**
 * Função de desativação da extensão.
 */
async function deactivate() {
  if (timerInterval) {
    clearInterval(timerInterval);
    vscode.window.showInformationMessage(`Code Tracking desativado`);
  }
}

module.exports = { activate, deactivate };
