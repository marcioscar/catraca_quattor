const LARGURA_FOTO = 480;
const ALTURA_FOTO = 640;

const statusEl = document.getElementById("status");
const formBusca = document.getElementById("form-busca");
const termoInput = document.getElementById("termo");
const buscaMensagemEl = document.getElementById("busca-mensagem");
const candidatosEl = document.getElementById("candidatos");
const alunoEncontradoEl = document.getElementById("aluno-encontrado");
const alunoNomeEl = document.getElementById("aluno-nome");
const alunoDetalheEl = document.getElementById("aluno-detalhe");
const videoEl = document.getElementById("video");
const canvasEl = document.getElementById("canvas");
const fotoPreviewEl = document.getElementById("foto-preview");
const btnCapturar = document.getElementById("btn-capturar");
const btnRecapturar = document.getElementById("btn-recapturar");
const btnCadastrar = document.getElementById("btn-cadastrar");
const tabelaAlunosBody = document.querySelector("#tabela-alunos tbody");
const tabelaAcessosBody = document.querySelector("#tabela-acessos tbody");

let alunoSelecionado = null;
let fotoBase64 = null;
let mediaStream = null;

function formatDataHora(iso) {
  const d = new Date(iso);
  const pad = (v) => String(v).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function atualizarStatus() {
  try {
    const resposta = await fetch("/catraca/status");
    const dados = await resposta.json();
    statusEl.textContent = dados.conectado
      ? "Catraca conectada"
      : "Catraca desconectada — cadastros ficam pendentes até ela reconectar";
    statusEl.className = dados.conectado ? "ok" : "off";
  } catch {
    statusEl.textContent = "Não foi possível checar o status da catraca.";
    statusEl.className = "off";
  }
}

async function carregarAlunos() {
  const resposta = await fetch("/catraca/alunos");
  const alunos = await resposta.json();
  tabelaAlunosBody.innerHTML = "";
  for (const aluno of alunos) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${aluno.nome ?? "-"}</td>
      <td>${aluno.idMember}</td>
      <td><span class="badge ${aluno.ativo ? "ativo" : "inativo"}">${aluno.ativo ? "Ativo" : "Inativo"}</span></td>
      <td>${formatDataHora(aluno.enroladoEm)}</td>
      <td><button class="secundario" data-remover="${aluno.idMember}">Remover</button></td>
    `;
    tabelaAlunosBody.appendChild(tr);
  }
}

async function carregarAcessos() {
  const resposta = await fetch("/catraca/acessos?take=50");
  const acessos = await resposta.json();
  const rotulos = { ok: "Liberado", plano_inativo: "Plano inativo", nao_cadastrado: "Não cadastrado" };
  tabelaAcessosBody.innerHTML = "";
  for (const acesso of acessos) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formatDataHora(acesso.ocorridoEm)}</td>
      <td>${acesso.nome ?? "-"}</td>
      <td>${acesso.idMember}</td>
      <td><span class="badge ${acesso.permitido ? "ativo" : "inativo"}">${rotulos[acesso.motivo] ?? acesso.motivo ?? "-"}</span></td>
    `;
    tabelaAcessosBody.appendChild(tr);
  }
}

function pararWebcam() {
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
}

async function iniciarWebcam() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { width: LARGURA_FOTO, height: ALTURA_FOTO },
      audio: false,
    });
    videoEl.srcObject = mediaStream;
    videoEl.hidden = false;
    btnCapturar.disabled = false;
  } catch {
    buscaMensagemEl.textContent = "Não foi possível acessar a câmera. Verifique a permissão do navegador.";
    buscaMensagemEl.className = "mensagem-erro";
  }
}

function capturarFoto() {
  const context = canvasEl.getContext("2d");
  const proporcaoAlvo = LARGURA_FOTO / ALTURA_FOTO;
  const proporcaoVideo = videoEl.videoWidth / videoEl.videoHeight;

  let recorteLargura = videoEl.videoWidth;
  let recorteAltura = videoEl.videoHeight;
  if (proporcaoVideo > proporcaoAlvo) {
    recorteLargura = videoEl.videoHeight * proporcaoAlvo;
  } else {
    recorteAltura = videoEl.videoWidth / proporcaoAlvo;
  }
  const offsetX = (videoEl.videoWidth - recorteLargura) / 2;
  const offsetY = (videoEl.videoHeight - recorteAltura) / 2;

  canvasEl.width = LARGURA_FOTO;
  canvasEl.height = ALTURA_FOTO;
  context.drawImage(videoEl, offsetX, offsetY, recorteLargura, recorteAltura, 0, 0, LARGURA_FOTO, ALTURA_FOTO);

  fotoBase64 = canvasEl.toDataURL("image/jpeg", 0.9);
  fotoPreviewEl.src = fotoBase64;
  fotoPreviewEl.hidden = false;
  videoEl.hidden = true;
  btnCapturar.hidden = true;
  btnRecapturar.hidden = false;
  btnCadastrar.disabled = false;
  pararWebcam();
}

function recapturarFoto() {
  fotoBase64 = null;
  fotoPreviewEl.hidden = true;
  btnRecapturar.hidden = true;
  btnCapturar.hidden = false;
  btnCadastrar.disabled = true;
  iniciarWebcam();
}

function mostrarAlunoEncontrado(consulta) {
  alunoSelecionado = consulta;
  alunoNomeEl.textContent = consulta.nome ?? `Membro ${consulta.idMember}`;
  alunoDetalheEl.textContent = `ID ${consulta.idMember} · ${consulta.plano ?? "sem plano"}`;
  alunoEncontradoEl.hidden = false;
  fotoBase64 = null;
  fotoPreviewEl.hidden = true;
  btnRecapturar.hidden = true;
  btnCapturar.hidden = false;
  btnCapturar.disabled = true;
  btnCadastrar.disabled = true;
  iniciarWebcam();
}

function limparResultadoBusca() {
  candidatosEl.innerHTML = "";
  alunoEncontradoEl.hidden = true;
  alunoSelecionado = null;
  pararWebcam();
}

async function buscarAluno(termo, idMember) {
  buscaMensagemEl.textContent = "Consultando EVO...";
  buscaMensagemEl.className = "";
  limparResultadoBusca();

  const params = new URLSearchParams();
  if (termo) params.set("termo", termo);
  if (idMember !== undefined) params.set("idMember", String(idMember));

  try {
    const resposta = await fetch(`/catraca/busca?${params}`);
    const dados = await resposta.json();

    if (dados.erro) {
      buscaMensagemEl.textContent = dados.erro;
      buscaMensagemEl.className = "mensagem-erro";
      return;
    }

    if (dados.candidatos && dados.candidatos.length > 0) {
      buscaMensagemEl.textContent = `Encontramos ${dados.candidatos.length} alunos com plano ativo. Selecione o correto:`;
      for (const candidato of dados.candidatos) {
        const li = document.createElement("li");
        const button = document.createElement("button");
        button.className = "secundario";
        button.textContent = `${candidato.nome} · ID ${candidato.idMember}${candidato.planoAtual ? " · " + candidato.planoAtual : ""}`;
        button.addEventListener("click", () => buscarAluno("", candidato.idMember));
        li.appendChild(button);
        candidatosEl.appendChild(li);
      }
      return;
    }

    if (dados.consulta?.encontrado) {
      buscaMensagemEl.textContent = "";
      mostrarAlunoEncontrado(dados.consulta);
      return;
    }

    buscaMensagemEl.textContent = "Nenhum aluno com plano ativo encontrado.";
    buscaMensagemEl.className = "mensagem-erro";
  } catch {
    buscaMensagemEl.textContent = "Falha ao consultar a EVO.";
    buscaMensagemEl.className = "mensagem-erro";
  }
}

async function cadastrarAluno() {
  if (!alunoSelecionado?.idMember || !alunoSelecionado?.nome || !fotoBase64) {
    return;
  }
  btnCadastrar.disabled = true;
  btnCadastrar.textContent = "Cadastrando...";

  try {
    const resposta = await fetch("/catraca/alunos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idMember: alunoSelecionado.idMember,
        nome: alunoSelecionado.nome,
        fotoBase64,
      }),
    });
    const dados = await resposta.json();

    if (dados.ok) {
      buscaMensagemEl.textContent = "Aluno cadastrado na catraca!";
      buscaMensagemEl.className = "mensagem-ok";
    } else if (dados.motivo === "device_offline") {
      buscaMensagemEl.textContent = "Aluno salvo, mas a catraca está offline agora — tente reenviar depois.";
      buscaMensagemEl.className = "mensagem-erro";
    } else {
      buscaMensagemEl.textContent = "Não foi possível cadastrar na catraca.";
      buscaMensagemEl.className = "mensagem-erro";
    }

    termoInput.value = "";
    limparResultadoBusca();
    await carregarAlunos();
  } catch {
    buscaMensagemEl.textContent = "Falha ao falar com a API da catraca.";
    buscaMensagemEl.className = "mensagem-erro";
  } finally {
    btnCadastrar.textContent = "Cadastrar na catraca";
  }
}

async function removerAluno(idMember) {
  await fetch(`/catraca/alunos/${idMember}`, { method: "DELETE" });
  await carregarAlunos();
}

formBusca.addEventListener("submit", (event) => {
  event.preventDefault();
  const termo = termoInput.value.trim();
  if (termo) {
    buscarAluno(termo);
  }
});

btnCapturar.addEventListener("click", capturarFoto);
btnRecapturar.addEventListener("click", recapturarFoto);
btnCadastrar.addEventListener("click", cadastrarAluno);

tabelaAlunosBody.addEventListener("click", (event) => {
  const idMember = event.target?.dataset?.remover;
  if (idMember) {
    removerAluno(Number(idMember));
  }
});

atualizarStatus();
carregarAlunos();
carregarAcessos();
setInterval(atualizarStatus, 15000);
setInterval(carregarAcessos, 15000);
