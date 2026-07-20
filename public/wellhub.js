const tabelaBody = document.querySelector("#tabela-checkins tbody");
const filtroEl = document.getElementById("checkins-filtro");
const diaEl = document.getElementById("checkins-dia");
const diaLimparEl = document.getElementById("checkins-dia-limpar");
const mensagemEl = document.getElementById("checkins-mensagem");

function filtroSelecionado() {
  return filtroEl.querySelector('input[name="filtro-checkins"]:checked').value;
}

function formatHora(iso) {
  const d = new Date(iso);
  const pad = (v) => String(v).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function iniciais(nome) {
  const partes = (nome ?? "").trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return "?";
  if (partes.length === 1) return partes[0][0].toUpperCase();
  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}

function avatar(c) {
  if (c.fotoBase64) return `<img class="avatar-mini" src="${c.fotoBase64}" alt="" />`;
  return `<span class="avatar-mini avatar-mini-iniciais">${iniciais(c.nome)}</span>`;
}

function statusBadge(c) {
  if (c.validado) return `<span class="badge ativo">Validado</span>`;
  if (c.validavel) return `<span class="badge tipo">Não validado</span>`;
  return `<span class="badge inativo">Expirado</span>`;
}

async function validar(gympassId, botao) {
  botao.disabled = true;
  botao.textContent = "Validando...";
  mensagemEl.textContent = "";
  mensagemEl.className = "detalhe";
  try {
    const resp = await fetch("/catraca/wellhub/validar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gympassId }),
    });
    const dados = await resp.json();
    if (dados.ok) {
      mensagemEl.textContent = dados.mensagem || "Check-in validado.";
      mensagemEl.className = "mensagem-ok";
    } else {
      mensagemEl.textContent = dados.mensagem || "Não foi possível validar.";
      mensagemEl.className = "mensagem-erro";
    }
  } catch {
    mensagemEl.textContent = "Falha ao falar com a API.";
    mensagemEl.className = "mensagem-erro";
  }
  await carregar();
}

async function carregar() {
  const dia = diaEl.value;
  const params = new URLSearchParams();
  if (dia) params.set("dia", dia);
  let checkins;
  try {
    const resp = await fetch(`/catraca/wellhub/checkins?${params}`);
    checkins = await resp.json();
  } catch {
    mensagemEl.textContent = "Falha ao carregar check-ins.";
    mensagemEl.className = "mensagem-erro";
    return;
  }

  const soNaoValidados = filtroSelecionado() === "nao_validados";
  const lista = soNaoValidados ? checkins.filter((c) => !c.validado) : checkins;

  tabelaBody.innerHTML = "";
  if (lista.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="5" class="detalhe">${soNaoValidados ? "Nenhum check-in não validado neste dia." : "Nenhum check-in neste dia."}</td>`;
    tabelaBody.appendChild(tr);
    return;
  }

  for (const c of lista) {
    const tr = document.createElement("tr");
    const nome = c.nome ?? `Wellhub ${c.gympassId}`;
    tr.innerHTML = `
      <td>${avatar(c)}</td>
      <td>${formatHora(c.recebidoEm)}</td>
      <td>${nome}${c.idMember ? ` <span class="detalhe">· ID ${c.idMember}</span>` : ` <span class="detalhe">· não cadastrado</span>`}</td>
      <td>${statusBadge(c)}</td>
      <td></td>
    `;
    if (c.validavel) {
      const botao = document.createElement("button");
      botao.textContent = "Validar";
      botao.addEventListener("click", () => validar(c.gympassId, botao));
      tr.lastElementChild.appendChild(botao);
    }
    tabelaBody.appendChild(tr);
  }
}

filtroEl.addEventListener("change", carregar);
diaEl.addEventListener("change", carregar);
diaLimparEl.addEventListener("click", () => {
  diaEl.value = "";
  carregar();
});

carregar();
// Atualiza sozinho só na visão ao vivo (sem dia fixado).
setInterval(() => {
  if (!diaEl.value) carregar();
}, 10000);
