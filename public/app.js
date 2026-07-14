const statusEl = document.getElementById("status");
const formBusca = document.getElementById("form-busca");
const termoInput = document.getElementById("termo");
const buscaMensagemEl = document.getElementById("busca-mensagem");
const candidatosEl = document.getElementById("candidatos");
const alunoEncontradoEl = document.getElementById("aluno-encontrado");
const alunoNomeEl = document.getElementById("aluno-nome");
const alunoDetalheEl = document.getElementById("aluno-detalhe");
const btnCadastrar = document.getElementById("btn-cadastrar");
const tabelaAlunosBody = document.querySelector("#tabela-alunos tbody");
const tabelaAcessosBody = document.querySelector("#tabela-acessos tbody");
const tipoToggleEl = document.getElementById("tipo-toggle");

function tipoSelecionado() {
  return tipoToggleEl.querySelector('input[name="tipo-cadastro"]:checked').value;
}

let alunoSelecionado = null;

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
      : "Catraca desconectada";
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
      <td><span class="badge tipo">${aluno.tipo === "colaborador" ? "Colaborador" : "Aluno"}</span></td>
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
  const rotulos = {
    ok: "Liberado",
    wellhub_ok: "Liberado — Wellhub",
    wellhub_provisorio: "Liberado — Wellhub (provisório)",
    plano_inativo: "Plano inativo",
    nao_cadastrado: "Não cadastrado",
  };
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

function mostrarAlunoEncontrado(consulta) {
  alunoSelecionado = consulta;
  alunoNomeEl.textContent = consulta.nome ?? `Membro ${consulta.idMember}`;
  alunoDetalheEl.textContent = `ID ${consulta.idMember} · ${consulta.plano ?? "sem plano"}`;
  alunoEncontradoEl.hidden = false;
}

function limparResultadoBusca() {
  candidatosEl.innerHTML = "";
  alunoEncontradoEl.hidden = true;
  alunoSelecionado = null;
}

async function buscarAluno(termo, idMember) {
  buscaMensagemEl.textContent = "Consultando EVO...";
  buscaMensagemEl.className = "";
  limparResultadoBusca();

  const tipo = tipoSelecionado();
  const params = new URLSearchParams();
  if (termo) params.set("termo", termo);
  if (idMember !== undefined) params.set("idMember", String(idMember));
  params.set("tipo", tipo);

  try {
    const resposta = await fetch(`/catraca/busca?${params}`);
    const dados = await resposta.json();

    if (dados.erro) {
      buscaMensagemEl.textContent = dados.erro;
      buscaMensagemEl.className = "mensagem-erro";
      return;
    }

    if (dados.candidatos && dados.candidatos.length > 0) {
      const rotuloLista = tipo === "colaborador" ? "colaboradores" : "alunos com plano ativo";
      buscaMensagemEl.textContent = `Encontramos ${dados.candidatos.length} ${rotuloLista}. Selecione o correto:`;
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

    buscaMensagemEl.textContent =
      tipo === "colaborador" ? "Nenhum colaborador encontrado." : "Nenhum aluno com plano ativo encontrado.";
    buscaMensagemEl.className = "mensagem-erro";
  } catch {
    buscaMensagemEl.textContent = "Falha ao consultar a EVO.";
    buscaMensagemEl.className = "mensagem-erro";
  }
}

async function cadastrarAluno() {
  if (!alunoSelecionado?.idMember || !alunoSelecionado?.nome) {
    return;
  }
  btnCadastrar.disabled = true;
  btnCadastrar.textContent = "Salvando...";

  try {
    const resposta = await fetch("/catraca/alunos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idMember: alunoSelecionado.idMember,
        nome: alunoSelecionado.nome,
        tipo: alunoSelecionado.tipo ?? "aluno",
      }),
    });
    const dados = await resposta.json();

    const rotuloTipo = alunoSelecionado.tipo === "colaborador" ? "Colaborador" : "Aluno";
    if (dados.ok) {
      buscaMensagemEl.textContent = `${rotuloTipo} classificado — falta cadastrar o rosto no painel do leitor, se ainda não foi.`;
      buscaMensagemEl.className = "mensagem-ok";
    } else {
      buscaMensagemEl.textContent = "Não foi possível salvar.";
      buscaMensagemEl.className = "mensagem-erro";
    }

    termoInput.value = "";
    limparResultadoBusca();
    await carregarAlunos();
  } catch {
    buscaMensagemEl.textContent = "Falha ao falar com a API da catraca.";
    buscaMensagemEl.className = "mensagem-erro";
  } finally {
    btnCadastrar.textContent = "Salvar classificação";
    btnCadastrar.disabled = false;
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

btnCadastrar.addEventListener("click", cadastrarAluno);

tipoToggleEl.addEventListener("change", () => {
  termoInput.value = "";
  buscaMensagemEl.textContent = "";
  limparResultadoBusca();
});

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
