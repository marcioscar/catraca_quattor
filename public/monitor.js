const telaEl = document.getElementById("tela");
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

let ultimoIdMostrado = null;

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

function mostrarAcesso(acesso) {
  telaEl.classList.remove("aguardando", "liberado", "negado");
  telaEl.classList.add(acesso.permitido ? "liberado" : "negado");

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

async function verificarNovoAcesso() {
  try {
    const resposta = await fetch("/catraca/acessos/ultimo");
    const acesso = await resposta.json();
    if (!acesso || acesso.id === ultimoIdMostrado) {
      return;
    }
    ultimoIdMostrado = acesso.id;
    mostrarAcesso(acesso);
  } catch {
    // Silencioso — só tenta de novo no próximo ciclo.
  }
}

verificarNovoAcesso();
setInterval(verificarNovoAcesso, 2000);
