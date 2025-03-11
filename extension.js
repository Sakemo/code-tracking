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

// Intervalo padrão em minutos (converteremos para ms)
let commitIntervalMinutes = 60;

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

  // Comando para exibir o Dashboard
  const dashboardCommand = vscode.commands.registerCommand(
    "auto-log.dashboard",
    async () => {
      await showDashboard(context);
    }
  );
  registerCommandContext(context, dashboardCommand);
}

/**
 * Registra os comandos no contexto da extensão.
 * @param {vscode.ExtensionContext} context
 * @param {*} command
 */
function registerCommandContext(context, command) {
  context.subscriptions.push(command);
}

/**
 * Abre o Dashboard utilizando Webview, buscando dados reais do GitHub.
 * @param {vscode.ExtensionContext} context
 */
async function showDashboard(context) {
  const panel = vscode.window.createWebviewPanel(
    "dashboard",
    "Estatísticas",
    vscode.ViewColumn.One,
    { enableScripts: true }
  );

  // Obtém as credenciais do usuário e configurações do repositório
  const login = await getUserLogin(context);
  if (!login) return;
  const { username, token } = login;
  const repoName = vscode.workspace
    .getConfiguration("autoLog")
    .get("repositoryName", "auto-log");

  // Data de instalação da extensão (salva na globalState)
  let installationDate = context.globalState.get("installationDate");
  if (!installationDate) {
    installationDate = new Date().toISOString();
    context.globalState.update("installationDate", installationDate);
  }

  // Busca os commits reais do repositório via API do GitHub
  const url = `https://api.github.com/repos/${username}/${repoName}/commits`;
  let commitsData = [];
  try {
    const response = await globalFetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok) {
      commitsData = await response.json();
    }
  } catch (e) {
    console.error("Erro ao buscar commits: ", e);
  }

  // Prepara o histórico de commits (exibe os 5 mais recentes)
  const commitHistory = commitsData.slice(0, 5).map((commit) => ({
    date: new Date(commit.commit.author.date).toLocaleString(),
    message: commit.commit.message,
    author: commit.commit.author.name,
  }));

  // Calcula médias baseadas em uma estimativa de 15 minutos por commit
  const MINUTES_PER_COMMIT = 15;
  const now = new Date();
  const dailyCount = commitsData.filter((commit) => {
    const commitDate = new Date(commit.commit.author.date);
    return now - commitDate <= 24 * 60 * 60 * 1000;
  }).length;
  const weeklyCount = commitsData.filter((commit) => {
    const commitDate = new Date(commit.commit.author.date);
    return now - commitDate <= 7 * 24 * 60 * 60 * 1000;
  }).length;
  const monthlyCount = commitsData.filter((commit) => {
    const commitDate = new Date(commit.commit.author.date);
    return now - commitDate <= 30 * 24 * 60 * 60 * 1000;
  }).length;

  const dailyAvg = formatTime(dailyCount * MINUTES_PER_COMMIT);
  const weeklyAvg = formatTime(weeklyCount * MINUTES_PER_COMMIT);
  const monthlyAvg = formatTime(monthlyCount * MINUTES_PER_COMMIT);

  const daysOfWeek = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"];
  const currentDayIndex = new Date().getDay();

  panel.webview.html = getDashboardHtml({
    installationDate,
    commitHistory,
    dailyAvg,
    weeklyAvg,
    monthlyAvg,
    daysOfWeek,
    currentDayIndex,
  });
}

/**
 * Formata minutos totais em uma string do tipo "Xh Ym".
 * @param {number} totalMinutes
 */
function formatTime(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours > 0 ? hours + "h " : ""}${minutes}m`;
}

/**
 * Gera o HTML do Dashboard com os dados fornecidos.
 * @param {Object} data
 */
function getDashboardHtml({
  installationDate,
  commitHistory,
  dailyAvg,
  weeklyAvg,
  monthlyAvg,
  daysOfWeek,
  currentDayIndex,
}) {
  return `
<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard de Estatísticas</title>
  <style>
    body {
      font-family: sans-serif;
      margin: 0;
      padding: 20px;
      background-color: #121212;
      color: #e0e0e0;
    }
    .container {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .card {
      background: #1e1e1e;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.8);
    }
    .card-header {
      font-weight: bold;
      margin-bottom: 10px;
      border-bottom: 1px solid #333;
      padding-bottom: 5px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(7, 20px);
      gap: 4px;
    }
    .square {
      width: 20px;
      height: 20px;
      background: #2c2c2c;
      border-radius: 3px;
    }
    .square.commit {
      background: #6f42c1;
    }
    .button {
      background: #007acc;
      color: #fff;
      border: none;
      padding: 8px 12px;
      border-radius: 4px;
      cursor: pointer;
    }
    .week-card {
      display: flex;
      gap: 10px;
    }
    .day-card {
      flex: 1;
      background: #2c2c2c;
      padding: 10px;
      text-align: center;
      border-radius: 4px;
    }
    .day-card.active {
      background: #007acc;
      color: #fff;
    }
    /* Modal */
    .modal {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .modal-content {
      background: #1e1e1e;
      padding: 20px;
      border-radius: 8px;
      max-width: 80%;
      max-height: 80%;
      overflow-y: auto;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.8);
    }
    .close-button {
      background: #d9534f;
      color: #fff;
      border: none;
      padding: 6px 10px;
      border-radius: 4px;
      cursor: pointer;
      float: right;
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Card: Gráfico de Commits -->
    <div class="card">
      <div class="card-header">Gráfico de Commits</div>
      <div class="grid">
        ${generateCommitChartHTML(installationDate)}
      </div>
    </div>
    <!-- Card: Histórico de Commits -->
    <div class="card">
      <div class="card-header">Histórico de Commits</div>
      <ul>
        ${commitHistory
          .map((commit) => `<li>${commit.date} - ${commit.message}</li>`)
          .join("")}
      </ul>
      <button class="button" onclick="showFullHistory()">Ler mais</button>
    </div>
    <!-- Card: Tempo Médio Programando -->
    <div class="card">
      <div class="card-header">Tempo Médio Programando</div>
      <p>Diário: ${dailyAvg}</p>
      <p>Semanal: ${weeklyAvg}</p>
      <p>Mensal: ${monthlyAvg}</p>
    </div>
    <!-- Card: Dias da Semana Programados -->
    <div class="card">
      <div class="card-header">Dias da Semana Programados</div>
      <div class="week-card">
        ${daysOfWeek
          .map(
            (day, index) =>
              `<div class="day-card ${
                index === currentDayIndex ? "active" : ""
              }">${day}</div>`
          )
          .join("")}
      </div>
    </div>
  </div>
  <!-- Modal para histórico completo -->
  <div id="modal" class="modal" style="display: none;">
    <div class="modal-content">
      <button class="close-button" onclick="closeModal()">Fechar</button>
      <h2>Histórico Completo de Commits</h2>
      <ul>
        ${commitHistory
          .map(
            (commit) =>
              `<li>${commit.date} - ${commit.message} (por ${commit.author})</li>`
          )
          .join("")}
      </ul>
    </div>
  </div>
  <script>
    function showFullHistory() {
      document.getElementById('modal').style.display = 'flex';
    }
    function closeModal() {
      document.getElementById('modal').style.display = 'none';
    }
  </script>
</body>
</html>
  `;
}

/**
 * Gera o HTML do gráfico de commits semelhante ao GitHub.
 * Destaca com um quadrado roxo a data de instalação da extensão.
 * Exibe os últimos 35 dias.
 * @param {string} installationDate
 */
function generateCommitChartHTML(installationDate) {
  const installDate = new Date(installationDate);
  let squares = [];
  // Exibe os últimos 35 dias (5 semanas)
  for (let i = 34; i >= 0; i--) {
    let day = new Date();
    day.setDate(day.getDate() - i);
    // Se a data do dia for igual à data de instalação, marca com "commit"
    if (day.toDateString() === installDate.toDateString()) {
      squares.push('<div class="square commit"></div>');
    } else {
      squares.push('<div class="square"></div>');
    }
  }
  return squares.join("");
}

/**
 * Gera um diff simples entre dois textos, linha a linha.
 * Linhas adicionadas são prefixadas com "+ " e removidas com "- ".
 * Retorna uma string vazia se não houver diferenças.
 * @param {string} oldStr - Conteúdo anterior
 * @param {string} newStr - Conteúdo atual
 * @returns {string} - Diferenças encontradas ou vazio se não houver alterações
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
  return diff.trim(); // Retorna vazio se não houver diferenças
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
    let stagedDiff = "";
    try {
      stagedDiff = await git.diff(["--staged"]);
    } catch (error) {
      console.error("Erro ao obter diff staged:", error);
      throw new Error("Não foi possível capturar mudanças staged no código");
    }
    const includeUnstaged = vscode.workspace
      .getConfiguration("autoLog")
      .get("includeUnstaged", false);
    let fullDiff = stagedDiff;
    if (includeUnstaged) {
      let unstagedDiff = "";
      try {
        unstagedDiff = await git.diff();
      } catch (error) {
        console.error("Erro ao obter diff unstaged:", error);
        throw new Error(
          "Não foi possível capturar mudanças unstaged no código"
        );
      }
      fullDiff += "\n" + unstagedDiff;
    }
    return fullDiff.trim(); // Retorna vazio se não houver mudanças
  } else {
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
    // Se o conteúdo atual estiver vazio, não há nada a ser commitado.
    if (currentContent.trim() === "") {
      console.warn("Arquivo vazio, nenhuma mudança detectada.");
      return "";
    }
    const stats = await fs.promises.stat(filePath);
    const thresholdTime = Date.now() - commitIntervalMinutes;
    if (stats.mtimeMs < thresholdTime) {
      console.warn("Nenhuma modificação detectada no arquivo aberto.");
      return "";
    }
    let diff = "";
    if (!lastFileContent[filePath]) {
      diff = currentContent;
    } else {
      diff = generateDiff(lastFileContent[filePath], currentContent);
    }
    // Atualiza sempre o lastFileContent para refletir o estado atual
    lastFileContent[filePath] = currentContent;
    return diff.trim() ? `Arquivo: ${filePath}\nDiferenças:\n${diff}\n` : "";
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
        { role: "developer", content: prompt },
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
  // Prepara o arquivo de log para o commit (arquivo "commit_log.txt")
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
      // Após o commit, reatualiza o conteúdo do arquivo (no modo não Git) para evitar re-commit das mesmas mudanças
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const filePathEditor = editor.document.uri.fsPath;
        try {
          const currentContent = await fs.promises.readFile(
            filePathEditor,
            "utf8"
          );
          lastFileContent[filePathEditor] = currentContent;
          vscode.window.showInformationMessage(
            "Conteúdo do arquivo atualizado."
          );
        } catch (err) {
          console.error(
            "Erro ao atualizar o conteúdo do arquivo após commit:",
            err
          );
        }
      }
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
