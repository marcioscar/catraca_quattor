const telaDetalheEl = document.getElementById("tela-detalhe");
const telaGradeEl = document.getElementById("tela-grade");
const gradeListaEl = document.getElementById("grade-lista");
const contadorHojeValorEl = document.getElementById("contador-hoje-valor");

const fotoEl = document.getElementById("foto");
const avatarEl = document.getElementById("avatar");
const resultadoEl = document.getElementById("resultado");
const nomeEl = document.getElementById("nome");
const detalheEl = document.getElementById("detalhe");
const horarioEl = document.getElementById("horario");

const ROTULOS = {
  ok: "Acesso liberado",
  wellhub_ok: "Acesso liberado — Wellhub",
  wellhub_provisorio: "Acesso liberado — Wellhub (provisório)",
  plano_inativo: "Plano inativo — negado",
  nao_cadastrado: "Não cadastrado — negado",
};

const MOTIVOS_WELLHUB = new Set(["wellhub_ok", "wellhub_provisorio"]);

const TEMPO_DETALHE_MS = 30000;
const QTD_GRADE = 42;
const INTERVALO_POLL_MS = 2000;
const INTERVALO_ATUALIZA_GRADE_MS = 5000;

let ultimoIdMostrado = null;
let timeoutVoltarGrade = null;

function iniciais(nome) {
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return "?";
  if (partes.length === 1) return partes[0][0].toUpperCase();
  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}

function formatHorario(iso) {
  const d = new Date(iso);
  const pad = (v) => String(v).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} às ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function mostrarTelaDetalhe() {
  telaDetalheEl.classList.add("ativa");
  telaGradeEl.classList.remove("ativa");
}

function mostrarTelaGrade() {
  telaGradeEl.classList.add("ativa");
  telaDetalheEl.classList.remove("ativa");
  carregarGrade();
}

function agendarVoltaParaGrade() {
  clearTimeout(timeoutVoltarGrade);
  timeoutVoltarGrade = setTimeout(mostrarTelaGrade, TEMPO_DETALHE_MS);
}

function mostrarAcesso(acesso) {
  telaDetalheEl.classList.remove("aguardando", "liberado", "negado");
  telaDetalheEl.classList.add(acesso.permitido ? "liberado" : "negado");

  resultadoEl.textContent = ROTULOS[acesso.motivo] ?? (acesso.permitido ? "Liberado" : "Negado");
  nomeEl.textContent = acesso.nome || `Membro ${acesso.idMember}`;

  let extra = "";
  if (MOTIVOS_WELLHUB.has(acesso.motivo)) {
    extra = " · via Wellhub";
  } else if (acesso.ativo === false) {
    extra = " · plano inativo na EVO";
  }
  detalheEl.textContent = `ID ${acesso.idMember}${extra}`;
  horarioEl.textContent = formatHorario(acesso.ocorridoEm);

  if (acesso.fotoBase64) {
    fotoEl.src = acesso.fotoBase64;
    fotoEl.hidden = false;
    avatarEl.hidden = true;
  } else {
    fotoEl.hidden = true;
    avatarEl.hidden = false;
    avatarEl.textContent = iniciais(acesso.nome || "?");
  }
}

function criarCard(acesso) {
  const card = document.createElement("div");
  card.className = `card ${acesso.permitido ? "liberado" : "negado"}`;

  const fotoWrap = document.createElement("div");
  fotoWrap.className = "card-foto";
  if (acesso.fotoBase64) {
    const img = document.createElement("img");
    img.src = acesso.fotoBase64;
    img.alt = "";
    fotoWrap.appendChild(img);
  } else {
    fotoWrap.textContent = iniciais(acesso.nome || "?");
  }

  const nome = document.createElement("p");
  nome.className = "card-nome";
  nome.textContent = acesso.nome || `Membro ${acesso.idMember}`;

  const hora = document.createElement("p");
  hora.className = "card-hora";
  hora.textContent = formatHorario(acesso.ocorridoEm);

  card.append(fotoWrap, nome, hora);
  return card;
}

async function carregarGrade() {
  try {
    const resposta = await fetch(`/catraca/acessos?take=${QTD_GRADE}`);
    const acessos = await resposta.json();
    if (!Array.isArray(acessos) || acessos.length === 0) {
      gradeListaEl.replaceChildren(Object.assign(document.createElement("p"), {
        className: "grade-vazia",
        textContent: "Nenhum acesso registrado ainda.",
      }));
      return;
    }
    gradeListaEl.replaceChildren(...acessos.map(criarCard));
  } catch {
    // Silencioso — só tenta de novo no próximo ciclo.
  }
}

async function atualizarContadorHoje() {
  try {
    const resposta = await fetch("/catraca/acessos/contagem-hoje");
    const dados = await resposta.json();
    contadorHojeValorEl.textContent = typeof dados.total === "number" ? dados.total : "—";
  } catch {
    // Silencioso — só tenta de novo no próximo ciclo.
  }
}

async function verificarNovoAcesso() {
  try {
    const resposta = await fetch("/catraca/acessos/ultimo");
    const acesso = await resposta.json();
    if (!acesso || acesso.id === ultimoIdMostrado) {
      return;
    }
    ultimoIdMostrado = acesso.id;
    mostrarAcesso(acesso);
    mostrarTelaDetalhe();
    agendarVoltaParaGrade();
  } catch {
    // Silencioso — só tenta de novo no próximo ciclo.
  }
}

mostrarTelaGrade();
atualizarContadorHoje();
verificarNovoAcesso();
setInterval(verificarNovoAcesso, INTERVALO_POLL_MS);
setInterval(() => {
  if (telaGradeEl.classList.contains("ativa")) {
    carregarGrade();
    atualizarContadorHoje();
  }
}, INTERVALO_ATUALIZA_GRADE_MS);
