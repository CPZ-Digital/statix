"use strict";
  // =====================================================================
  // CAMPEONATO — vários técnicos, cada um com seu time, sincronizado num
  // banco central (Supabase) via link de convite. Módulo separado do resto
  // do app (que continua 100% local por dispositivo) pra não arriscar
  // quebrar o que já funciona.
  // =====================================================================
  // SUPABASE_URL, SUPABASE_KEY e o cliente supaAuth já vêm declarados globalmente por js/app-gate.js
  // (que carrega antes pra travar o app inteiro) — reaproveitados aqui, não redeclarar.

  async function currentSession(){
    const { data } = await supaAuth.auth.getSession();
    return data.session;
  }

  // authed=true assina a chamada com o token do organizador logado (exigido pelas policies de escrita
  // de campeonato/confronto/estatística); sem isso cai na anon key, só válida pra leitura e pro fluxo do técnico.
  async function sb(path, opts={}, authed=false){
    let bearer = SUPABASE_KEY;
    if(authed){
      const session = await currentSession();
      if(!session) throw new Error('Sessão expirada — faça login de novo.');
      bearer = session.access_token;
    }
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...opts,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(opts.headers||{})
      }
    });
    if(!res.ok) throw new Error(await res.text().catch(()=>res.statusText));
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // toast fixo pra dar feedback de sincronizacao com o servidor (salvando/salvo/falhou)
  let toastTimer = null;
  function showToast(msg, kind){
    let el = document.getElementById('sync-toast');
    if(!el){
      el = document.createElement('div');
      el.id = 'sync-toast';
      el.className = 'sync-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = 'sync-toast show ' + (kind||'');
    clearTimeout(toastTimer);
    if(kind !== 'loading'){
      toastTimer = setTimeout(()=> el.classList.remove('show'), kind==='error' ? 4000 : 1400);
    }
  }
  function hideToast(){
    const el = document.getElementById('sync-toast');
    if(el) el.classList.remove('show');
  }

  // roda uma escrita no Supabase com feedback visual e nova tentativa manual em caso de falha
  async function sbWrite(path, opts, successMsg, authed=false){
    showToast('Salvando…', 'loading');
    try{
      const result = await sb(path, opts, authed);
      showToast(successMsg || 'Salvo', 'success');
      return result;
    }catch(e){
      // fetch só lança TypeError quando a rede cai de verdade — qualquer outro erro é o servidor
      // recusando a ação (RLS, regra de negócio etc), que é bem diferente de "sem internet" e
      // confundia o organizador quando as duas apareciam com a mesma mensagem genérica.
      const isNetworkFailure = e instanceof TypeError;
      let friendly = 'Falha ao salvar — sem conexão com o servidor. Toque pra tentar de novo.';
      if(!isNetworkFailure){
        let serverMsg = '';
        try{ serverMsg = JSON.parse(e.message).message || ''; }catch(_){}
        friendly = serverMsg && serverMsg !== 'PIN_INCORRETO' ? `Falha ao salvar — ${serverMsg}` : 'Falha ao salvar — o servidor recusou essa ação.';
      }
      showToast(friendly, 'error');
      const el = document.getElementById('sync-toast');
      if(el) el.onclick = ()=>{ el.onclick=null; sbWrite(path, opts, successMsg, authed); };
      throw e;
    }
  }

  // única porta de leitura pra quem só tem o link de convite (organizador, técnico ou espectador) —
  // championships/teams/players/matches não são mais lidos direto da tabela (RLS fechou isso), essa
  // RPC devolve tudo de uma vez, igual ao que o "select=true" antigo deixava ver, só que exigindo o
  // código de verdade em vez de dar pra listar o banco inteiro sem ele.
  async function fetchChampSnapshot(inviteCode){
    return sb('rpc/rpc_champ_snapshot', { method:'POST', body: JSON.stringify({ p_code: inviteCode }) });
  }

  async function sha256(text){
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
  }

  // estatística completa por jogador na partida — pts é coluna gerada no banco (2*fg2m + 3*fg3m + ftm),
  // nunca mandar no INSERT/PATCH. Tempo de quadra soma o acumulado + o turno atual se ainda estiver em quadra.
  const EMPTY_STAT = { fg2m:0, fg2a:0, fg3m:0, fg3a:0, ftm:0, fta:0, reb:0, ast:0, stl:0, pf:0, pts:0 };
  function fmtMinutes(sec){ const m = Math.floor(sec/60), s = sec%60; return `${m}:${String(s).padStart(2,'0')}`; }
  function mpSeconds(mp){
    if(!mp) return 0;
    let sec = mp.seconds_played || 0;
    if(mp.on_court && mp.last_in_at) sec += Math.max(0, Math.round((Date.now() - new Date(mp.last_in_at).getTime())/1000));
    return sec;
  }
  function statButtonsHTML(pid){
    return `
      <button class="stat-btn make" data-pid="${pid}" data-changes='{"fg2m":1,"fg2a":1}'>2pt ✓</button>
      <button class="stat-btn miss" data-pid="${pid}" data-changes='{"fg2a":1}'>2pt ✗</button>
      <button class="stat-btn make" data-pid="${pid}" data-changes='{"fg3m":1,"fg3a":1}'>3pt ✓</button>
      <button class="stat-btn miss" data-pid="${pid}" data-changes='{"fg3a":1}'>3pt ✗</button>
      <button class="stat-btn make" data-pid="${pid}" data-changes='{"ftm":1,"fta":1}'>ll ✓</button>
      <button class="stat-btn miss" data-pid="${pid}" data-changes='{"fta":1}'>ll ✗</button>
      <button class="stat-btn" data-pid="${pid}" data-changes='{"reb":1}'>+ rebote</button>
      <button class="stat-btn" data-pid="${pid}" data-changes='{"ast":1}'>+ assist.</button>
      <button class="stat-btn" data-pid="${pid}" data-changes='{"stl":1}'>+ roubo</button>
      <button class="stat-btn miss" data-pid="${pid}" data-changes='{"pf":1}'>+ falta</button>`;
  }
  function statLineHTML(s, sec){
    return `${s.pts||0} pts · ${s.fg2m}/${s.fg2a} 2pt · ${s.fg3m}/${s.fg3a} 3pt · ${s.ftm}/${s.fta} ll · ${s.reb} reb · ${s.ast} ast · ${s.stl} rb · ${s.pf} faltas · ${fmtMinutes(sec)} em quadra`;
  }

  // champCode() já vem definida globalmente por js/app-gate.js (que carrega antes de tudo,
  // inclusive do app-core.js, que também precisa dela) — não redeclarar aqui.
  function champSessionKey(code){ return `statix-champ-session-${code}`; }
  function loadChampSession(code){ try{ return JSON.parse(localStorage.getItem(champSessionKey(code))||'null'); }catch(e){ return null; } }
  function saveChampSession(code, session){ try{ localStorage.setItem(champSessionKey(code), JSON.stringify(session)); }catch(e){} }
  function genInviteCode(){
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({length:6},()=>chars[Math.floor(Math.random()*chars.length)]).join('');
  }

  let champUI = { view:'loading', championship:null, teamId:null, pin:null, tree:null, error:null };

  function goToDashboard(){
    const url = new URL(location.href);
    url.searchParams.delete('c');
    history.replaceState(null, '', url);
    renderChamp();
  }

  function watchParam(){ return new URLSearchParams(location.search).get('watch') || ''; }

  async function renderChamp(){
    const el = document.getElementById('champ-body');
    const code = champCode();
    const watchId = watchParam();

    // placar público — sem login, sem PIN, qualquer um com o link vê ao vivo (leitura já é aberta no RLS)
    if(code && watchId){
      await renderPublicMatch(code, watchId);
      return;
    }

    if(!code){
      await renderDashboard();
      return;
    }

    el.innerHTML = `<div class="panel"><div class="empty">Carregando campeonato…</div></div>`;
    let championship;
    try{
      const snapshot = await fetchChampSnapshot(code);
      championship = snapshot && snapshot.championship;
    }catch(e){
      el.innerHTML = champErrorHTML('Não deu pra conectar ao servidor. Verifique a internet e tente de novo.');
      return;
    }
    if(!championship){
      el.innerHTML = champErrorHTML('Link de campeonato inválido ou expirado.');
      return;
    }
    champUI.championship = championship;

    // se quem abriu o link é o dono OU um co-organizador convidado deste campeonato, pula o
    // cadastro de técnico e vai direto pro painel de scout — validado no banco, não no front.
    const session = await currentSession();
    const isOwner = !!(session && championship.owner_id === session.user.id);
    let isCoOrganizer = false;
    if(session && !isOwner){
      try{
        const rows = await sb(`championship_organizers?championship_id=eq.${championship.id}&email=eq.${encodeURIComponent((session.user.email||'').toLowerCase())}&select=email`, {}, true);
        isCoOrganizer = rows && rows.length > 0;
      }catch(e){}
    }
    if(isOwner || isCoOrganizer){
      champUI.isOwner = isOwner;
      await renderChampOverall(championship, true, isOwner);
      return;
    }

    const teamSession = loadChampSession(code);
    if(teamSession && teamSession.teamId){
      champUI.teamId = teamSession.teamId; champUI.pin = teamSession.pin;
      await renderChampTeamPanel();
    } else {
      el.innerHTML = champJoinHTML(championship);
      wireChampJoin(championship);
    }
  }

  function champErrorHTML(msg){
    return `<div class="panel"><div class="empty">${escapeHtml(msg)}</div></div>`;
  }

  // ---------- DASHBOARD DO ORGANIZADOR (login + "meus campeonatos") ----------
  async function renderDashboard(){
    const el = document.getElementById('champ-body');
    el.innerHTML = `<div class="panel"><div class="empty">Carregando…</div></div>`;
    const session = await currentSession();
    if(!session){
      el.innerHTML = dashLoginHTML();
      wireDashLogin();
      return;
    }
    let licensed;
    try{
      const rows = await sb(`licenses?email=eq.${encodeURIComponent((session.user.email||'').toLowerCase())}&select=email`, {}, true);
      licensed = rows && rows.length > 0;
    }catch(e){
      el.innerHTML = champErrorHTML('Não deu pra confirmar sua licença. Verifique a internet e volte a essa tela.');
      return;
    }
    if(!licensed){
      el.innerHTML = dashNoLicenseHTML(session);
      document.getElementById('btn-dash-logout').addEventListener('click', async ()=>{
        await supaAuth.auth.signOut();
        renderDashboard();
      });
      return;
    }
    let mine;
    try{
      const email = (session.user.email||'').toLowerCase();
      const [owned, coOrgRows] = await Promise.all([
        sb(`championships?owner_id=eq.${session.user.id}&select=*&order=created_at.desc`, {}, true),
        sb(`championship_organizers?email=eq.${encodeURIComponent(email)}&select=championships(*)`, {}, true)
      ]);
      const coOrganized = (coOrgRows||[]).map(r=>({ ...r.championships, _coOrg:true })).filter(c=>c && c.id);
      mine = [...owned.map(c=>({...c, _coOrg:false})), ...coOrganized];
    }catch(e){
      el.innerHTML = champErrorHTML('Não deu pra carregar seus campeonatos. Verifique a internet e volte a essa tela.');
      return;
    }
    el.innerHTML = `
      <div class="panel">
        <span class="eyebrow">Organizador</span>
        <h2>Meus campeonatos</h2>
        <div style="color:var(--ink-dim);font-size:12.5px;margin-bottom:6px;">${escapeHtml(session.user.email)}</div>
        <button class="btn ghost" id="btn-dash-logout">Sair da conta</button>
        <div class="roster-list" style="margin-top:16px;">
          ${mine.length ? mine.map(c=>`
            <div class="roster-row">
              <span class="name">${escapeHtml(c.name)}${c.archived ? ' <span style="color:var(--miss);font-size:11px;">(encerrado)</span>' : ''}${c._coOrg ? ' <span style="color:var(--ink-dim);font-size:11px;">(co-organizador)</span>' : ''}</span>
              <span style="color:var(--ink-dim);font-family:'JetBrains Mono';font-size:11px;">${escapeHtml(c.invite_code)}</span>
              ${!c._coOrg ? `<button type="button" class="btn dash-share-champ" data-id="${c.id}" data-code="${escapeHtml(c.invite_code)}" title="Chamar co-organizador">Compartilhar</button>` : ''}
              <button type="button" class="btn dash-open-champ" data-code="${escapeHtml(c.invite_code)}">Abrir</button>
              ${!c._coOrg ? `<button type="button" class="icon-btn danger dash-delete-champ" data-id="${c.id}" data-name="${escapeHtml(c.name)}" title="Excluir"><svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"></line><line x1="18" y1="6" x2="6" y2="18"></line></svg></button>` : ''}
            </div>`).join('') : `<div class="empty">Nenhum campeonato criado ainda.</div>`}
        </div>
      </div>
      <div class="panel" style="margin-top:16px;">
        <span class="eyebrow">Novo</span>
        <h2>Criar campeonato</h2>
        <div class="row row-stack">
          <input type="text" id="champ-name" placeholder="Nome do campeonato" style="flex:2;min-width:200px;">
          <button class="btn primary" id="btn-create-champ">Criar campeonato</button>
        </div>
        <div id="champ-create-msg" style="margin-top:10px;font-family:'JetBrains Mono';font-size:12px;color:var(--ink-dim);"></div>
      </div>
      <div class="panel" style="margin-top:16px;">
        <span class="eyebrow">Fui convidado</span>
        <h2>Entrar num campeonato como técnico</h2>
        <div class="row row-stack">
          <input type="text" id="champ-code-input" placeholder="Código do convite (ex: A3F9K2)" style="flex:2;min-width:200px;text-transform:uppercase;">
          <button class="btn" id="btn-goto-champ">Entrar</button>
        </div>
      </div>`;

    document.getElementById('btn-dash-logout').addEventListener('click', async ()=>{
      await supaAuth.auth.signOut();
      renderDashboard();
    });
    el.querySelectorAll('.dash-open-champ').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const url = new URL(location.href);
        url.searchParams.set('c', btn.dataset.code);
        history.replaceState(null, '', url);
        renderChamp();
      });
    });
    el.querySelectorAll('.dash-share-champ').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const email = prompt('E-mail de quem já tem licença Statix, pra virar co-organizador desse campeonato:');
        if(!email) return;
        try{
          await sbWrite('championship_organizers', { method:'POST', body: JSON.stringify({ championship_id: btn.dataset.id, email: email.trim().toLowerCase() }) }, 'Co-organizador adicionado', true);
        }catch(e){ alert('Erro — confirme que esse e-mail já tem licença Statix.'); }
      });
    });
    el.querySelectorAll('.dash-delete-champ').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        if(!confirm(`Excluir "${btn.dataset.name}" de vez? Times, jogadores e confrontos somem junto — não dá pra desfazer.`)) return;
        try{
          await sbWrite(`championships?id=eq.${btn.dataset.id}`, { method:'DELETE' }, 'Campeonato excluído', true);
          renderDashboard();
        }catch(e){}
      });
    });
    document.getElementById('btn-create-champ').addEventListener('click', async (ev)=>{
      const btn = ev.currentTarget;
      if(btn.disabled) return;
      const name = document.getElementById('champ-name').value.trim();
      const msg = document.getElementById('champ-create-msg');
      if(!name){ msg.textContent = 'Digite um nome pro campeonato.'; return; }
      msg.textContent = 'Criando…';
      btn.disabled = true;
      try{
        let created = null, tries = 0;
        while(!created && tries < 5){
          tries++;
          const code = genInviteCode();
          try{
            const rows = await sb('championships', { method:'POST', body: JSON.stringify({ name, invite_code: code, owner_id: session.user.id }) }, true);
            created = rows[0];
          }catch(e){ /* código colidiu, tenta outro */ }
        }
        if(!created){ msg.textContent = 'Erro ao criar. Tenta de novo.'; btn.disabled = false; return; }
        const url = new URL(location.href);
        url.searchParams.set('c', created.invite_code);
        history.replaceState(null, '', url);
        renderChamp();
      }catch(e){ msg.textContent = 'Erro ao criar campeonato.'; btn.disabled = false; }
    });
    document.getElementById('btn-goto-champ').addEventListener('click', ()=>{
      const code = document.getElementById('champ-code-input').value.trim().toUpperCase();
      if(!code) return;
      const url = new URL(location.href);
      url.searchParams.set('c', code);
      history.replaceState(null, '', url);
      renderChamp();
    });
  }

  function dashNoLicenseHTML(session){
    return `
      <div class="panel">
        <span class="eyebrow">Organizador</span>
        <h2>Sem licença ativa</h2>
        <p style="color:var(--ink-dim);font-size:13px;margin:-6px 0 16px;">A conta <strong style="color:var(--ink);">${escapeHtml(session.user.email)}</strong> logou certinho, mas ainda não tem uma licença liberada pra criar ou gerenciar campeonatos. Peça acesso e a gente libera pra esse e-mail.</p>
        <div class="row">
          <a class="btn primary" href="https://cpzdigital.com.br/statix#contato" target="_blank" rel="noopener">Pedir licença →</a>
          <button class="btn ghost" id="btn-dash-logout">Sair da conta</button>
        </div>
      </div>`;
  }

  function dashLoginHTML(){
    return `
      <div class="panel">
        <span class="eyebrow">Organizador</span>
        <h2>Entrar ou criar conta</h2>
        <p style="color:var(--ink-dim);font-size:13px;margin:-6px 0 16px;">Só o organizador com licença ativa acessa o painel — pra criar campeonatos, gerenciar vários ao mesmo tempo e rodar o scout ao vivo dos confrontos. Técnico convidado não precisa de conta: só usa o link. <a href="https://cpzdigital.com.br/statix#contato" target="_blank" rel="noopener" style="color:var(--accent);">Ainda não tem licença? Peça aqui.</a></p>
        <button type="button" class="btn" id="btn-dash-google" style="width:100%;margin-bottom:14px;">Entrar com o Google</button>
        <div style="text-align:center;color:var(--ink-dim);font-family:'JetBrains Mono';font-size:11px;margin-bottom:14px;">— ou com e-mail e senha —</div>
        <div class="row row-stack">
          <input type="text" id="dash-email" placeholder="E-mail" style="flex:1;min-width:200px;">
          <input type="text" id="dash-pass" placeholder="Senha" style="flex:1;min-width:160px;">
        </div>
        <div class="row" style="margin-top:12px;">
          <button class="btn primary" id="btn-dash-login">Entrar</button>
          <button class="btn" id="btn-dash-signup">Criar conta</button>
        </div>
        <div id="dash-login-msg" style="margin-top:10px;font-family:'JetBrains Mono';font-size:12px;color:var(--miss);"></div>
      </div>
      <div class="panel" style="margin-top:16px;">
        <span class="eyebrow">Fui convidado</span>
        <h2>Entrar num campeonato como técnico</h2>
        <div class="row row-stack">
          <input type="text" id="champ-code-input" placeholder="Código do convite (ex: A3F9K2)" style="flex:2;min-width:200px;text-transform:uppercase;">
          <button class="btn" id="btn-goto-champ">Entrar</button>
        </div>
      </div>`;
  }

  function wireDashLogin(){
    const msg = document.getElementById('dash-login-msg');
    document.getElementById('btn-dash-google').addEventListener('click', async ()=>{
      const { error } = await supaAuth.auth.signInWithOAuth({ provider:'google', options:{ redirectTo: location.href } });
      if(error) msg.textContent = 'Login com Google ainda não está configurado.';
    });
    document.getElementById('btn-dash-login').addEventListener('click', async ()=>{
      const email = document.getElementById('dash-email').value.trim();
      const password = document.getElementById('dash-pass').value;
      msg.textContent = 'Entrando…';
      const { error } = await supaAuth.auth.signInWithPassword({ email, password });
      if(error){ msg.textContent = 'E-mail ou senha inválidos.'; return; }
      renderDashboard();
    });
    document.getElementById('btn-dash-signup').addEventListener('click', async ()=>{
      const email = document.getElementById('dash-email').value.trim();
      const password = document.getElementById('dash-pass').value;
      if(!email || password.length < 6){ msg.textContent = 'Preencha o e-mail e uma senha com 6+ caracteres.'; return; }
      msg.textContent = 'Criando conta…';
      const { error } = await supaAuth.auth.signUp({ email, password });
      if(error){ msg.textContent = error.message; return; }
      msg.textContent = 'Conta criada. Se pedir confirmação, confira seu e-mail antes de entrar.';
    });
    document.getElementById('btn-goto-champ').addEventListener('click', ()=>{
      const code = document.getElementById('champ-code-input').value.trim().toUpperCase();
      if(!code) return;
      const url = new URL(location.href);
      url.searchParams.set('c', code);
      history.replaceState(null, '', url);
      renderChamp();
    });
  }

  function champJoinHTML(championship){
    const link = location.origin + location.pathname + '?c=' + championship.invite_code;
    const joinSection = championship.archived
      ? `<div style="margin-top:10px;color:var(--miss);font-size:13px;">🔒 Essa temporada foi encerrada pelo organizador — só leitura, não dá mais pra cadastrar time ou jogador novo.</div>`
      : `
        <div class="eyebrow">Entrar como técnico</div>
        <div class="row row-stack">
          <input type="text" id="champ-team-name" placeholder="Nome do seu time" style="flex:1;min-width:160px;">
          <input type="text" id="champ-team-pin" placeholder="PIN (crie um, 4 dígitos)" style="max-width:200px;" inputmode="numeric" maxlength="8">
          <button class="btn primary" id="btn-join-team">Entrar / criar time</button>
        </div>
        <div style="margin-top:10px;color:var(--ink-dim);font-size:12px;">⚠️ Anote esse nome de time e PIN — é com eles que você acessa seu time de qualquer aparelho (celular, tablet, computador), sempre por este mesmo link.</div>
        <div id="champ-join-msg" style="margin-top:10px;font-family:'JetBrains Mono';font-size:12px;color:var(--miss);"></div>`;
    return `
      <div class="panel">
        <span class="eyebrow">Campeonato</span>
        <h2>${escapeHtml(championship.name)}</h2>
        <div class="row" style="margin-bottom:16px;">
          <input type="text" readonly value="${escapeHtml(link)}" style="flex:1;min-width:180px;font-size:12px;" id="champ-link-field">
          <button class="btn" id="btn-copy-link">Copiar link</button>
        </div>
        ${joinSection}
        <div style="margin-top:14px;text-align:center;">
          <a href="${location.origin}${location.pathname}" style="color:var(--ink-dim);font-size:11px;text-decoration:underline;">Sou o organizador, entrar na minha conta →</a>
        </div>
      </div>`;
  }

  function wireChampJoin(championship){
    document.getElementById('btn-copy-link').addEventListener('click', ()=>{
      const field = document.getElementById('champ-link-field');
      field.select();
      navigator.clipboard?.writeText(field.value).catch(()=>document.execCommand('copy'));
    });
    const joinBtn = document.getElementById('btn-join-team');
    if(!joinBtn) return; // campeonato encerrado — sem formulário de entrada nessa tela
    joinBtn.addEventListener('click', async ()=>{
      if(joinBtn.disabled) return;
      const name = document.getElementById('champ-team-name').value.trim();
      const pin = document.getElementById('champ-team-pin').value.trim();
      const msg = document.getElementById('champ-join-msg');
      if(!name || !pin){ msg.textContent = 'Preencha o nome do time e um PIN.'; return; }
      msg.textContent = 'Entrando…';
      joinBtn.disabled = true;
      try{
        // PIN validado no servidor via RPC (rpc_team_join) — nunca mais só no client, e o hash
        // do time nunca mais trafega de volta pro navegador (antes vazava em qualquer select=*).
        const team = await sb('rpc/rpc_team_join', { method:'POST', body: JSON.stringify({ p_championship_id: championship.id, p_name: name, p_pin: pin }) });
        saveChampSession(championship.invite_code, { teamId: team.id, pin });
        champUI.teamId = team.id; champUI.pin = pin;
        await renderChampTeamPanel();
      }catch(e){
        msg.textContent = String(e.message||'').includes('PIN_INCORRETO') ? 'Já existe um time com esse nome e o PIN não confere.' : 'Erro ao entrar. Tenta de novo.';
      } finally {
        joinBtn.disabled = false;
      }
    });
  }

  function champRankingsFromMatches(matches){
    const byPlayer = {};
    matches.filter(m=>m.finished).forEach(m=>{
      m.match_players.forEach(mp=>{
        // conta "jogo" só pra quem realmente pisou em quadra — reserva que ficou 100% no banco
        // não deveria contar como GP e distorcer as médias por jogo.
        const played = (mp.seconds_played||0) > 0 || mp.starter;
        if(!played) return;
        if(!byPlayer[mp.player_id]){
          byPlayer[mp.player_id] = { name:mp.players.name, num:mp.players.num, team:mp.teams.name, gp:0, pts:0,reb:0,ast:0,fg3m:0,stl:0,sec:0 };
        }
        const s = m.match_stats.find(x=>x.player_id===mp.player_id) || {pts:0,reb:0,ast:0,fg3m:0,stl:0};
        const row = byPlayer[mp.player_id];
        // confronto encerrado já tem seconds_played travado no valor final (finishChampMatch/WO
        // congelam isso) — dá pra somar direto, sem precisar de mpSeconds() com relógio corrente.
        row.gp++; row.pts+=s.pts; row.reb+=s.reb; row.ast+=s.ast; row.fg3m+=s.fg3m; row.stl+=s.stl; row.sec+=(mp.seconds_played||0);
      });
    });
    return Object.values(byPlayer).map(r=>{
      const div = r.gp||1;
      return { ...r, ppg:r.pts/div, rpg:r.reb/div, apg:r.ast/div, spg:r.stl/div, mpg:r.sec/div };
    }).sort((a,b)=>b.ppg-a.ppg);
  }

  async function renderChampOverall(championship, viewOnly, isOwner = champUI.isOwner){
    const el = document.getElementById('champ-body');
    el.innerHTML = `<div class="panel"><div class="empty">Carregando…</div></div>`;
    let teams, matches, organizers = [];
    try{
      const snapshot = await fetchChampSnapshot(championship.invite_code);
      if(!snapshot) throw new Error('not found');
      teams = snapshot.teams; matches = snapshot.matches;
      if(isOwner) organizers = await sb(`championship_organizers?championship_id=eq.${championship.id}&select=email`, {}, true);
    }catch(e){
      el.innerHTML = champErrorHTML('Não deu pra carregar os dados do campeonato. Verifique a internet e volte a essa tela.');
      return;
    }
    const rows = champRankingsFromMatches(matches);
    const format = championship.format || 'pontos_corridos';
    const maxRound = matches.length ? Math.max(...matches.map(m=>m.round||1)) : 0;
    const maxRoundMatches = matches.filter(m=>(m.round||1)===maxRound);
    const maxRoundAllFinished = maxRoundMatches.length>0 && maxRoundMatches.every(m=>m.finished);
    const aliveTeams = champAliveTeams(teams, matches);
    const champion = (format==='eliminatorias' && matches.length>0 && maxRoundAllFinished && aliveTeams.length<=1) ? aliveTeams[0] : null;
    const canAdvance = format==='eliminatorias' && matches.length>0 && maxRoundAllFinished && aliveTeams.length>1;
    const canDrawFirstRound = format==='eliminatorias' && matches.length===0;
    const canGenerateRoundRobin = format==='pontos_corridos' && matches.length===0;
    const standings = format==='pontos_corridos' ? champStandingsFromMatches(teams, matches) : null;
    const backBtn = `<button class="btn ghost" id="btn-champ-back" style="margin-bottom:16px;">← voltar</button>`;
    const inviteLink = `${location.origin}${location.pathname}?c=${championship.invite_code}`;
    el.innerHTML = `
      ${backBtn}
      <div class="panel">
        <span class="eyebrow">Organizador${championship.archived ? ' · encerrado' : ''}</span>
        <h2>${escapeHtml(championship.name)}</h2>
        <div class="row" style="margin-bottom:14px;">
          <input type="text" readonly value="${escapeHtml(inviteLink)}" style="flex:1;min-width:180px;font-size:12px;" id="champ-invite-field">
          <button class="btn" id="btn-copy-invite">Copiar link de convite</button>
          <span style="color:var(--ink-dim);font-family:'JetBrains Mono';font-size:12px;">código: ${escapeHtml(championship.invite_code)}</span>
        </div>
        <div class="row" style="margin-bottom:14px;align-items:center;">
          <span class="eyebrow" style="margin:0;">Formato</span>
          <select id="champ-format" ${championship.archived?'disabled':''} style="max-width:280px;">
            <option value="pontos_corridos" ${format==='pontos_corridos'?'selected':''}>Pontos corridos (todos × todos)</option>
            <option value="eliminatorias" ${format==='eliminatorias'?'selected':''}>Eliminatórias (mata-mata)</option>
          </select>
        </div>
        <div class="row">
          <button class="btn primary" id="btn-new-match" ${teams.length<2 || championship.archived ?'disabled':''}>Novo confronto (scout ao vivo)</button>
          ${format==='eliminatorias' ? `
            <button class="btn" id="btn-draw-bracket" ${!canDrawFirstRound || teams.length<2 || championship.archived ?'disabled':''}>🎲 Sortear chave (1ª rodada)</button>
            ${canAdvance && !championship.archived ? `<button class="btn" id="btn-advance-round">▶ Gerar rodada ${maxRound+1}</button>` : ''}
          ` : `
            <button class="btn" id="btn-round-robin" ${!canGenerateRoundRobin || teams.length<2 || championship.archived ?'disabled':''}>🎲 Gerar confrontos (todos × todos)</button>
          `}
        </div>
        ${champion ? `<div style="margin-top:10px;color:var(--make);font-weight:700;">🏆 Campeão: ${escapeHtml(champion.name)}</div>` : ''}
        ${teams.length<2 ? `<div style="margin-top:8px;color:var(--ink-dim);font-size:12px;">Precisa de pelo menos 2 times cadastrados no campeonato — mande o link de convite acima pros técnicos, ou cadastre um time você mesmo abaixo.</div>` : ''}
        ${championship.archived ? `<div style="margin-top:8px;color:var(--miss);font-size:12px;">Campeonato encerrado — só leitura, não dá mais pra criar confronto novo.</div>` : ''}
      </div>
      ${isOwner ? `
      <div class="panel" style="margin-top:16px;">
        <span class="eyebrow">Colaboração</span>
        <h2>Co-organizadores</h2>
        <p style="color:var(--ink-dim);font-size:12.5px;margin:-4px 0 12px;">Outra pessoa com licença pode controlar o scout ao vivo desse campeonato junto com você — tipo dois árbitros na mesma súmula, cada um no seu dispositivo.</p>
        <div class="roster-list" style="margin-bottom:14px;">
          ${organizers.length ? organizers.map(o=>`<div class="roster-row"><span class="name">${escapeHtml(o.email)}</span><button type="button" class="icon-btn danger btn-remove-organizer" data-email="${escapeHtml(o.email)}" title="Remover"><svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"></line><line x1="18" y1="6" x2="6" y2="18"></line></svg></button></div>`).join('') : `<div class="empty">Só você organiza esse campeonato por enquanto.</div>`}
        </div>
        <div class="row row-stack">
          <input type="text" id="champ-org-email" placeholder="E-mail de quem já tem licença Statix" style="flex:1;min-width:220px;">
          <button class="btn primary" id="btn-add-organizer">Adicionar co-organizador</button>
        </div>
        <div id="champ-org-msg" style="margin-top:10px;font-family:'JetBrains Mono';font-size:12px;color:var(--miss);"></div>
      </div>
      <div class="panel" style="margin-top:16px;">
        <span class="eyebrow">Zona de risco</span>
        <h2>Encerrar ou excluir</h2>
        <div class="row">
          <button class="btn" id="btn-toggle-archive">${championship.archived ? 'Reabrir campeonato' : 'Encerrar campeonato'}</button>
          <button class="btn ghost" id="btn-delete-champ" style="color:var(--miss);">Excluir campeonato</button>
        </div>
        <div style="margin-top:8px;color:var(--ink-dim);font-size:12px;">Encerrar só trava novos confrontos, mantém tudo salvo. Excluir apaga o campeonato, times, jogadores e confrontos — sem volta.</div>
      </div>` : ''}
      <div class="panel" style="margin-top:16px;">
        <span class="eyebrow">Times</span>
        <h2>Times do campeonato</h2>
        <div class="roster-list" style="margin-bottom:16px;">
          ${teams.length ? teams.map(t=>`<div class="roster-row"><button type="button" class="name btn-open-team-roster" data-id="${t.id}" style="background:none;border:none;padding:0;text-align:left;cursor:pointer;color:var(--accent);text-decoration:underline;">${escapeHtml(t.name)}</button><span style="color:var(--ink-dim);font-family:'JetBrains Mono';font-size:11px;">${t.players.length} jogador(es)</span><button type="button" class="icon-btn danger btn-remove-team" data-id="${t.id}" data-name="${escapeHtml(t.name)}" title="Excluir time"><svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"></line><line x1="18" y1="6" x2="6" y2="18"></line></svg></button></div>`).join('') : `<div class="empty">Nenhum time cadastrado ainda.</div>`}
        </div>
        <div style="color:var(--ink-dim);font-size:11px;margin-bottom:14px;">Excluir um time também apaga os confrontos dele — se ele já tiver jogo marcado, prefira dar WO no histórico abaixo antes de excluir.</div>
        <div class="eyebrow">Cadastrar time sem link de convite</div>
        <p style="color:var(--ink-dim);font-size:12.5px;margin:-4px 0 12px;">Útil se o técnico não vai usar o app — você cadastra o time e o elenco direto por aqui.</p>
        <div class="row row-stack">
          <input type="text" id="champ-newteam-name" placeholder="Nome do time" style="flex:1;min-width:160px;">
          <input type="text" id="champ-newteam-pin" placeholder="PIN (crie um, pra se precisar depois)" style="max-width:220px;" inputmode="numeric" maxlength="8">
          <button class="btn primary" id="btn-champ-newteam">Adicionar time</button>
        </div>
        <div id="champ-newteam-msg" style="margin-top:10px;font-family:'JetBrains Mono';font-size:12px;color:var(--miss);"></div>
      </div>
      ${format==='pontos_corridos' ? `
      <div class="panel" style="margin-top:16px;">
        <span class="eyebrow">Temporada</span>
        <h2>Classificação</h2>
        <div class="table-wrap">
          <table><thead><tr><th>#</th><th>Time</th><th>J</th><th>V</th><th>D</th><th>SG</th></tr></thead>
          <tbody>
            ${standings.length ? standings.map((t,i)=>`<tr>
              <td class="rank-num">${i+1}</td><td>${escapeHtml(t.name)}</td><td>${t.gp}</td><td>${t.w}</td><td>${t.l}</td><td>${t.sg>0?'+':''}${t.sg}</td>
            </tr>`).join('') : `<tr><td colspan="6" class="empty">Nenhum confronto encerrado ainda.</td></tr>`}
          </tbody></table>
        </div>
      </div>` : ''}
      <div class="panel" style="margin-top:16px;">
        <span class="eyebrow">Temporada</span>
        <h2>Ranking geral</h2>
        <div style="color:var(--ink-dim);font-family:'JetBrains Mono';font-size:11.5px;margin-bottom:14px;">${teams.length} time(s) participando</div>
        <div class="table-wrap">
          <table><thead><tr><th>#</th><th>Jogador</th><th>Time</th><th>Jogos</th><th>MIN</th><th>PPG</th><th>RPG</th><th>APG</th><th>SPG</th></tr></thead>
          <tbody>
            ${rows.length ? rows.map((r,i)=>`<tr>
              <td class="rank-num">${i+1}</td>
              <td>${escapeHtml(r.name)} <span style="color:var(--ink-dim);">#${escapeHtml(r.num||'—')}</span></td>
              <td>${escapeHtml(r.team)}</td>
              <td>${r.gp}</td><td>${fmtMinutes(Math.round(r.mpg))}</td><td>${r.ppg.toFixed(1)}</td><td>${r.rpg.toFixed(1)}</td><td>${r.apg.toFixed(1)}</td><td>${r.spg.toFixed(1)}</td>
            </tr>`).join('') : `<tr><td colspan="9" class="empty">Nenhuma estatística registrada ainda.</td></tr>`}
          </tbody></table>
        </div>
      </div>
      <div class="panel" style="margin-top:16px;">
        <span class="eyebrow">Histórico</span>
        <h2>Confrontos</h2>
        <div class="roster-list">
          ${matches.length ? matches.map((m,idx)=>{
            function scoreFor(teamName){
              return m.match_stats.reduce((s,x)=>{
                const mp = m.match_players.find(p=>p.player_id===x.player_id);
                return (mp && mp.teams && mp.teams.name===teamName) ? s+x.pts : s;
              },0);
            }
            const a = scoreFor(m.teamA.name), b = scoreFor(m.teamB.name);
            const d = new Date(m.played_at);
            const resultLine = m.wo_winner_team_id
              ? `<span style="color:var(--miss);">W.O. pra ${escapeHtml(m.wo_winner_team_id===m.team_a_id ? m.teamA.name : m.teamB.name)}</span>`
              : `<span class="num" style="color:var(--ink-dim);">${a}</span> × <span class="num" style="color:var(--ink-dim);">${b}</span>`;
            // eliminatórias: agrupa visualmente por rodada (chaveamento) — pontos corridos não tem
            // rodada de verdade (todo mundo já sai marcado de uma vez), não precisa do cabeçalho.
            const roundHeading = (format==='eliminatorias' && (idx===0 || (matches[idx-1].round||1)!==(m.round||1)))
              ? `<div class="eyebrow" style="margin-top:${idx===0?'0':'14px'};">Rodada ${m.round||1}</div>` : '';
            return `${roundHeading}<div class="roster-row">
              <span class="name">${escapeHtml(m.teamA.name)} vs ${escapeHtml(m.teamB.name)} — ${resultLine}</span>
              <span style="color:var(--ink-dim);font-family:'JetBrains Mono';font-size:11px;">${d.toLocaleDateString('pt-BR')} ${m.finished?'· encerrado':'· em andamento'}</span>
              ${!m.finished ? `<button data-mid="${m.id}" class="btn btn-resume-match" style="color:var(--accent);">continuar</button>
              <button data-mid="${m.id}" data-team="${m.team_a_id}" class="btn ghost btn-wo-match" title="Dar WO pro ${escapeHtml(m.teamA.name)}" style="font-size:11px;">WO ${escapeHtml(m.teamA.name)}</button>
              <button data-mid="${m.id}" data-team="${m.team_b_id}" class="btn ghost btn-wo-match" title="Dar WO pro ${escapeHtml(m.teamB.name)}" style="font-size:11px;">WO ${escapeHtml(m.teamB.name)}</button>` : ''}
            </div>`;
          }).join('') : `<div class="empty">Nenhum confronto criado ainda.</div>`}
        </div>
      </div>`;
    document.getElementById('btn-champ-back').addEventListener('click', goToDashboard);
    document.getElementById('btn-champ-newteam').addEventListener('click', async (ev)=>{
      const btn = ev.currentTarget;
      if(btn.disabled) return;
      const name = document.getElementById('champ-newteam-name').value.trim();
      const pin = document.getElementById('champ-newteam-pin').value.trim();
      const msg = document.getElementById('champ-newteam-msg');
      if(!name || !pin){ msg.textContent = 'Preencha o nome do time e um PIN.'; return; }
      if(teams.some(t=>t.name===name)){ msg.textContent = 'Já existe um time com esse nome nesse campeonato.'; return; }
      msg.textContent = 'Adicionando…';
      btn.disabled = true;
      try{
        const pinHash = await sha256(pin);
        await sbWrite('teams', { method:'POST', body: JSON.stringify({ championship_id: championship.id, name, pin: pinHash }) }, 'Time adicionado', true);
        renderChampOverall(championship, true);
      }catch(e){ msg.textContent = 'Erro ao adicionar — talvez já exista um time com esse nome.'; btn.disabled = false; }
    });
    document.getElementById('btn-copy-invite').addEventListener('click', ()=>{
      const field = document.getElementById('champ-invite-field');
      field.select();
      navigator.clipboard?.writeText(field.value).catch(()=>document.execCommand('copy'));
      showToast('Link copiado', 'success');
    });
    document.getElementById('champ-format').addEventListener('change', async (ev)=>{
      const newFormat = ev.currentTarget.value;
      try{
        await sbWrite(`championships?id=eq.${championship.id}`, { method:'PATCH', body: JSON.stringify({ format: newFormat }) }, 'Formato atualizado', true);
        renderChampOverall({ ...championship, format: newFormat }, true, isOwner);
      }catch(e){ renderChampOverall(championship, true, isOwner); }
    });
    if(isOwner){
      document.getElementById('btn-add-organizer').addEventListener('click', async ()=>{
        const email = document.getElementById('champ-org-email').value.trim().toLowerCase();
        const msg = document.getElementById('champ-org-msg');
        if(!email){ msg.textContent = 'Digite um e-mail.'; return; }
        msg.textContent = 'Adicionando…';
        try{
          await sbWrite('championship_organizers', { method:'POST', body: JSON.stringify({ championship_id: championship.id, email }) }, 'Co-organizador adicionado', true);
          renderChampOverall(championship, true, isOwner);
        }catch(e){ msg.textContent = 'Erro — confirme que esse e-mail já tem licença Statix.'; }
      });
      el.querySelectorAll('.btn-remove-organizer').forEach(btn=>{
        btn.addEventListener('click', async ()=>{
          try{
            await sbWrite(`championship_organizers?championship_id=eq.${championship.id}&email=eq.${encodeURIComponent(btn.dataset.email)}`, { method:'DELETE' }, 'Removido', true);
            renderChampOverall(championship, true, isOwner);
          }catch(e){}
        });
      });
      document.getElementById('btn-toggle-archive').addEventListener('click', async ()=>{
        try{
          await sbWrite(`championships?id=eq.${championship.id}`, { method:'PATCH', body: JSON.stringify({ archived: !championship.archived }) }, championship.archived ? 'Campeonato reaberto' : 'Campeonato encerrado', true);
          renderChampOverall({ ...championship, archived: !championship.archived }, true, isOwner);
        }catch(e){}
      });
      document.getElementById('btn-delete-champ').addEventListener('click', async ()=>{
        if(!confirm(`Excluir "${championship.name}" de vez? Times, jogadores e confrontos somem junto — não dá pra desfazer.`)) return;
        try{
          await sbWrite(`championships?id=eq.${championship.id}`, { method:'DELETE' }, 'Campeonato excluído', true);
          goToDashboard();
        }catch(e){}
      });
    }
    if(teams.length>=2 && !championship.archived){
      document.getElementById('btn-new-match').addEventListener('click', ()=> renderMatchSetup(championship, teams));
      const drawBtn = document.getElementById('btn-draw-bracket');
      if(drawBtn) drawBtn.addEventListener('click', async (ev)=>{
        const btn = ev.currentTarget;
        if(btn.disabled) return;
        const { pairs, bye } = pairWithBye(teams);
        if(!confirm(`Sortear ${pairs.length} confronto(s) pra 1ª rodada?${bye ? `\n${bye.name} fica de bye (folga) por ser número ímpar de times.` : ''}`)) return;
        btn.disabled = true;
        try{
          await createRoundMatches(championship, pairs, 1);
          showToast('Chave sorteada', 'success');
          renderChampOverall(championship, true, isOwner);
        }catch(e){ showToast('Falha ao sortear a chave.', 'error'); btn.disabled = false; }
      });
      const advanceBtn = document.getElementById('btn-advance-round');
      if(advanceBtn) advanceBtn.addEventListener('click', async (ev)=>{
        const btn = ev.currentTarget;
        if(btn.disabled) return;
        const { pairs, bye } = pairWithBye(aliveTeams);
        if(!confirm(`Gerar a rodada ${maxRound+1} com ${pairs.length} confronto(s)?${bye ? `\n${bye.name} fica de bye (folga) por ser número ímpar de times ainda vivos.` : ''}`)) return;
        btn.disabled = true;
        try{
          await createRoundMatches(championship, pairs, maxRound+1);
          showToast(`Rodada ${maxRound+1} gerada`, 'success');
          renderChampOverall(championship, true, isOwner);
        }catch(e){ showToast('Falha ao gerar a próxima rodada.', 'error'); btn.disabled = false; }
      });
      const roundRobinBtn = document.getElementById('btn-round-robin');
      if(roundRobinBtn) roundRobinBtn.addEventListener('click', async (ev)=>{
        const btn = ev.currentTarget;
        if(btn.disabled) return;
        const pairs = [];
        for(let i=0;i<teams.length;i++) for(let j=i+1;j<teams.length;j++) pairs.push([teams[i], teams[j]]);
        if(!confirm(`Gerar todos os ${pairs.length} confronto(s) do turno único (cada time joga contra todos os outros uma vez)?`)) return;
        btn.disabled = true;
        try{
          await createRoundMatches(championship, pairs, 1);
          showToast('Confrontos gerados', 'success');
          renderChampOverall(championship, true, isOwner);
        }catch(e){ showToast('Falha ao gerar os confrontos.', 'error'); btn.disabled = false; }
      });
    }
    el.querySelectorAll('.btn-resume-match').forEach(btn=>{
      btn.addEventListener('click', ()=> renderMatchLive(championship, teams, btn.dataset.mid));
    });
    el.querySelectorAll('.btn-wo-match').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        if(!confirm('Confirmar WO? O confronto encerra sem estatística, só com o vencedor registrado.')) return;
        try{
          // se o confronto já tinha ficado "em andamento" com alguém em quadra, precisa fechar o
          // tempo de jogo/cronômetro desses jogadores igual o "Encerrar confronto" normal já fazia
          // — senão seconds_played fica travado em 0 e o jogador some do ranking mesmo tendo jogado.
          let clockFinal = 0;
          try{
            const match = await fetchMatch(btn.dataset.mid);
            await freezeOnCourtPlayers(btn.dataset.mid, match);
            clockFinal = matchClockSeconds(match);
          }catch(_){}
          await sbWrite(`matches?id=eq.${btn.dataset.mid}`, { method:'PATCH', body: JSON.stringify({ finished:true, wo_winner_team_id: btn.dataset.team, clock_seconds: clockFinal, clock_running_since: null }) }, 'WO registrado', true);
          renderChampOverall(championship, true, isOwner);
        }catch(e){}
      });
    });
    el.querySelectorAll('.btn-remove-team').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        if(!confirm(`Excluir o time "${btn.dataset.name}"? Isso também apaga os confrontos dele. Não dá pra desfazer.`)) return;
        try{
          await sbWrite(`teams?id=eq.${btn.dataset.id}`, { method:'DELETE' }, 'Time excluído', true);
          renderChampOverall(championship, true, isOwner);
        }catch(e){}
      });
    });
    el.querySelectorAll('.btn-open-team-roster').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const team = teams.find(t=>t.id===btn.dataset.id);
        if(team) renderChampTeamRosterAsOrganizer(championship, team, isOwner);
      });
    });
  }

  // organizador gerencia o elenco de qualquer time do campeonato direto — necessário pros times que
  // ele mesmo cadastrou sem link de convite, que senão nunca teriam como adicionar jogador.
  async function renderChampTeamRosterAsOrganizer(championship, team, isOwner){
    const el = document.getElementById('champ-body');
    el.innerHTML = `
      <button class="btn ghost" id="btn-roster-org-back" style="margin-bottom:16px;">← voltar</button>
      <div class="panel">
        <span class="eyebrow">Campeonato · ${escapeHtml(championship.name)}</span>
        <h2>${escapeHtml(team.name)}</h2>
        <div class="row" style="margin-bottom:10px;">
          <input type="text" id="champ-player-name" placeholder="Nome do jogador *" style="flex:2;min-width:160px;">
          <input type="text" id="champ-player-num" placeholder="Nº *" style="max-width:80px;" inputmode="numeric">
        </div>
        <div class="row">
          ${champPlayerAttrFieldsHTML()}
        </div>
        <div style="color:var(--ink-dim);font-size:11px;margin:8px 0;">* campos obrigatórios: número da camisa, posição, altura e peso. Nascimento, envergadura, impulsão e velocidade são opcionais.</div>
        <button class="btn primary" id="champ-add-player">Adicionar jogador</button>
        <div id="champ-player-msg" style="margin-top:10px;font-family:'JetBrains Mono';font-size:12px;color:var(--miss);"></div>
        <div class="roster-list" id="champ-roster" style="margin-top:12px;">
          ${team.players.length ? team.players.map(p=>`
            <div class="roster-row">
              <span class="jersey">${escapeHtml(p.num||'—')}</span>
              <span class="name">${escapeHtml(p.name)}${p.attrs && p.attrs.position ? ` <span style="color:var(--ink-dim);font-size:11px;">${escapeHtml(p.attrs.position)}</span>` : ''}</span>
              <button type="button" class="icon-btn danger champ-remove-player" data-pid="${p.id}" title="Remover jogador">
                <svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"></line><line x1="18" y1="6" x2="6" y2="18"></line></svg>
              </button>
            </div>
          `).join('') : `<div class="empty">Nenhum jogador ainda.</div>`}
        </div>
      </div>`;

    document.getElementById('btn-roster-org-back').addEventListener('click', ()=> renderChampOverall(championship, true, isOwner));
    document.getElementById('champ-add-player').addEventListener('click', async (ev)=>{
      const btn = ev.currentTarget;
      if(btn.disabled) return;
      const name = document.getElementById('champ-player-name').value.trim();
      const num = document.getElementById('champ-player-num').value.trim();
      const msg = document.getElementById('champ-player-msg');
      const attrs = readChampPlayerAttrs();
      const missing = CHAMP_REQUIRED_ATTRS.filter(k=>!attrs[k]);
      if(!name){ msg.textContent = 'Preencha o nome do jogador.'; return; }
      if(!num){ msg.textContent = 'Preencha o número da camisa.'; return; }
      if(missing.length){ msg.textContent = 'Preencha posição, altura e peso — são obrigatórios.'; return; }
      msg.textContent = '';
      btn.disabled = true;
      try{
        await sbWrite('players', { method:'POST', body: JSON.stringify({ team_id: team.id, name, num, attrs }) }, 'Jogador adicionado', true);
        const fresh = await fetchChampSnapshot(championship.invite_code);
        renderChampTeamRosterAsOrganizer(championship, fresh.teams.find(t=>t.id===team.id), isOwner);
      }catch(e){ msg.textContent = 'Erro ao adicionar jogador.'; btn.disabled = false; }
    });
    document.querySelectorAll('.champ-remove-player').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        if(btn.disabled) return;
        btn.disabled = true;
        try{
          await sbWrite(`players?id=eq.${btn.dataset.pid}`, { method:'DELETE' }, 'Jogador removido', true);
          const fresh = await fetchChampSnapshot(championship.invite_code);
          renderChampTeamRosterAsOrganizer(championship, fresh.teams.find(t=>t.id===team.id), isOwner);
        }catch(e){ btn.disabled = false; }
      });
    });
  }

  // ---------- SCOUT AO VIVO (confronto entre dois times do campeonato) ----------
  function renderMatchSetup(championship, teams){
    const el = document.getElementById('champ-body');
    el.innerHTML = `
      <button class="btn ghost" id="btn-match-back" style="margin-bottom:16px;">← voltar</button>
      <div class="panel">
        <span class="eyebrow">Novo confronto</span>
        <h2>Escolha os dois times</h2>
        <div class="row row-stack">
          <select id="match-team-a" style="flex:1;min-width:160px;">${teams.map(t=>`<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')}</select>
          <span style="align-self:center;color:var(--ink-dim);font-family:'JetBrains Mono';">vs</span>
          <select id="match-team-b" style="flex:1;min-width:160px;">${teams.map((t,i)=>`<option value="${t.id}" ${i===1?'selected':''}>${escapeHtml(t.name)}</option>`).join('')}</select>
        </div>
        <button class="btn primary" id="btn-confirm-match" style="margin-top:14px;">Definir titulares e banco</button>
      </div>`;
    document.getElementById('btn-match-back').addEventListener('click', ()=> renderChampOverall(championship, true));
    document.getElementById('btn-confirm-match').addEventListener('click', ()=>{
      const teamAId = document.getElementById('match-team-a').value;
      const teamBId = document.getElementById('match-team-b').value;
      if(teamAId===teamBId){ alert('Escolha dois times diferentes.'); return; }
      const teamA = teams.find(t=>t.id===teamAId);
      const teamB = teams.find(t=>t.id===teamBId);
      // o confronto só é gravado no banco quando o organizador clicar "Começar confronto" (dentro de
      // renderMatchRoster) — antes disso o registro era criado aqui, e sair no meio (voltar, fechar a
      // aba) deixava um jogo fantasma 0×0 travado no histórico, sem jogador nenhum e sem como excluir.
      renderMatchRoster(championship, teams, teamA, teamB);
    });
  }

  function renderMatchRoster(championship, teams, teamA, teamB){
    const starters = {}; // player_id -> bool, default false (banco)

    function teamBlock(team){
      return `
        <div class="panel">
          <span class="eyebrow">${escapeHtml(team.name)}</span>
          <h2>Titulares e banco</h2>
          <div class="roster-list">
            ${team.players.length ? team.players.map(p=>`
              <div class="roster-row">
                <span class="jersey">${escapeHtml(p.num||'—')}</span>
                <span class="name">${escapeHtml(p.name)}</span>
                <button type="button" class="filter-chip starter-toggle" data-pid="${p.id}" data-team="${team.id}">Banco</button>
              </div>`).join('') : `<div class="empty">Time sem jogadores cadastrados.</div>`}
          </div>
        </div>`;
    }

    const el = document.getElementById('champ-body');
    el.innerHTML = `
      <button class="btn ghost" id="btn-roster-back" style="margin-bottom:16px;">← voltar</button>
      <div class="panel">
        <span class="eyebrow">Confronto</span>
        <h2>${escapeHtml(teamA.name)} vs ${escapeHtml(teamB.name)}</h2>
        <div style="color:var(--ink-dim);font-size:12.5px;">clique nos jogadores que vão começar em quadra como titulares — o resto entra como banco</div>
      </div>
      ${teamBlock(teamA)}
      ${teamBlock(teamB)}
      <button class="btn primary" id="btn-start-match" style="margin-top:6px;">Começar confronto</button>`;

    document.getElementById('btn-roster-back').addEventListener('click', ()=> renderChampOverall(championship, true));
    el.querySelectorAll('.starter-toggle').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const on = !starters[btn.dataset.pid];
        if(on){
          // máximo 5 titulares em quadra por time — sem essa trava dava pra marcar o time inteiro
          // como titular e a súmula abria com 6+ jogadores em quadra ao mesmo tempo (bug real de QA).
          const team = btn.dataset.team === teamA.id ? teamA : teamB;
          const currentStarters = team.players.filter(p=>starters[p.id]).length;
          if(currentStarters >= 5){ alert('Só pode ter 5 titulares em quadra por time — tire um titular antes de marcar outro.'); return; }
        }
        starters[btn.dataset.pid] = on;
        btn.classList.toggle('active', on);
        btn.textContent = on ? 'Titular' : 'Banco';
      });
    });
    document.getElementById('btn-start-match').addEventListener('click', async (ev)=>{
      const btn = ev.currentTarget;
      if(btn.disabled) return;
      btn.disabled = true;
      try{
        const matchRows = await sbWrite('matches', { method:'POST', body: JSON.stringify({ championship_id: championship.id, team_a_id: teamA.id, team_b_id: teamB.id }) }, 'Confronto criado', true);
        const match = matchRows[0];
        const rosterRows = [...teamA.players, ...teamB.players].map(p=>({
          match_id: match.id,
          player_id: p.id,
          team_id: teamA.players.includes(p) ? teamA.id : teamB.id,
          starter: !!starters[p.id],
          on_court: !!starters[p.id],
          // last_in_at só é setado quando o cronômetro do jogo é iniciado (wireMatchClockControls/
          // startMatchClock) — antes disso ninguém deveria estar "acumulando" tempo de quadra.
          last_in_at: null
        }));
        if(rosterRows.length) await sbWrite('match_players', { method:'POST', body: JSON.stringify(rosterRows) }, 'Escalação salva', true);
        renderMatchLive(championship, teams, match.id);
      }catch(e){ btn.disabled = false; }
    });
  }

  // uso exclusivo da súmula ao vivo do organizador — autenticado, por isso ainda lê a tabela direto
  // (agora restrita por RLS a quem é organizador/co-organizador daquele campeonato). O placar público
  // e o painel do técnico usam fetchChampSnapshot, que não exige login.
  async function fetchMatch(matchId){
    const rows = await sb(`matches?id=eq.${matchId}&select=*,match_players(player_id,team_id,starter,on_court,seconds_played,last_in_at),match_stats(player_id,pts,fg2m,fg2a,fg3m,fg3a,ftm,fta,reb,ast,stl,pf)`, {}, true);
    return rows[0];
  }

  // cronômetro de jogo — mesmo padrão de mpSeconds() pro tempo de quadra: soma o acumulado com o
  // trecho corrente se estiver rodando.
  function matchClockSeconds(match){
    let sec = match.clock_seconds || 0;
    if(match.clock_running_since) sec += Math.max(0, Math.round((Date.now() - new Date(match.clock_running_since).getTime())/1000));
    return sec;
  }

  // congela o tempo de quadra de quem tá em quadra (mesmo helper usado por encerrar/WO/pausar) —
  // sem isso o jogador continuaria contando tempo de jogo com o relógio da partida parado.
  async function freezeOnCourtPlayers(matchId, match){
    for(const mp of match.match_players.filter(x=>x.on_court && x.last_in_at)){
      await sb(`match_players?match_id=eq.${matchId}&player_id=eq.${mp.player_id}`, { method:'PATCH', body: JSON.stringify({ seconds_played: mpSeconds(mp), last_in_at:null }) }, true);
    }
  }

  async function startMatchClock(matchId){
    const match = await fetchMatch(matchId);
    const now = new Date().toISOString();
    await sb(`matches?id=eq.${matchId}`, { method:'PATCH', body: JSON.stringify({ clock_running_since: now }) }, true);
    // quem já tá em quadra sem last_in_at (titular que nunca rodou o relógio, ou retomando de uma
    // pausa) passa a contar tempo de novo, junto com o cronômetro.
    for(const mp of match.match_players.filter(x=>x.on_court && !x.last_in_at)){
      await sb(`match_players?match_id=eq.${matchId}&player_id=eq.${mp.player_id}`, { method:'PATCH', body: JSON.stringify({ last_in_at: now }) }, true);
    }
  }

  async function pauseMatchClock(matchId){
    const match = await fetchMatch(matchId);
    const total = matchClockSeconds(match);
    await freezeOnCourtPlayers(matchId, match);
    await sb(`matches?id=eq.${matchId}`, { method:'PATCH', body: JSON.stringify({ clock_seconds: total, clock_running_since: null }) }, true);
  }

  async function stopMatchClock(matchId){
    const match = await fetchMatch(matchId);
    await freezeOnCourtPlayers(matchId, match);
    await sb(`matches?id=eq.${matchId}`, { method:'PATCH', body: JSON.stringify({ clock_seconds: 0, clock_running_since: null }) }, true);
  }

  // controles de iniciar/pausar/parar reaproveitados pela súmula e pelo Modo Quadra — cada tela
  // só passa o id do bloco onde o relógio deve aparecer e a função de re-render depois da ação.
  let clockTickTimer = null;
  function wireMatchClockControls(prefix, match, onChange){
    const elClock = document.getElementById(`${prefix}-clock`);
    const btnStart = document.getElementById(`${prefix}-clock-start`);
    const btnPause = document.getElementById(`${prefix}-clock-pause`);
    const btnStop = document.getElementById(`${prefix}-clock-stop`);
    if(!elClock) return;
    const running = !!match.clock_running_since;
    elClock.textContent = fmtMinutes(matchClockSeconds(match));
    if(btnStart) btnStart.style.display = running ? 'none' : '';
    if(btnPause) btnPause.style.display = running ? '' : 'none';
    clearInterval(clockTickTimer);
    if(running){
      clockTickTimer = setInterval(()=>{ elClock.textContent = fmtMinutes(matchClockSeconds(match)); }, 1000);
    }
    if(btnStart) btnStart.onclick = async ()=>{ btnStart.disabled = true; try{ await startMatchClock(match.id); onChange(); }catch(e){ btnStart.disabled = false; } };
    if(btnPause) btnPause.onclick = async ()=>{ btnPause.disabled = true; try{ await pauseMatchClock(match.id); onChange(); }catch(e){ btnPause.disabled = false; } };
    if(btnStop) btnStop.onclick = async ()=>{
      if(!confirm('Zerar o cronômetro? Volta pra 0:00 (o tempo de jogo já registrado não muda).')) return;
      btnStop.disabled = true;
      try{ await stopMatchClock(match.id); onChange(); }catch(e){ btnStop.disabled = false; }
    };
  }

  // flusha o tempo de quadra de quem ainda tá em quadra e marca o confronto como encerrado —
  // compartilhado entre o botão "Encerrar confronto" da súmula e o botão equivalente dentro do
  // Modo Quadra, pra não ter duas cópias da mesma lógica (e do mesmo bug, se um dia precisar mexer).
  // cria os confrontos de uma leva (usado pelo sorteio de chave, pelo "gerar confrontos" de pontos
  // corridos e por "gerar próxima rodada" das eliminatórias) — sempre com match_players já povoado
  // (todo mundo no banco), senão a súmula abre vazia sem jeito de colocar titular (bug real de QA).
  async function createRoundMatches(championship, pairs, round){
    for(const [a,b] of pairs){
      const rows = await sb('matches', { method:'POST', body: JSON.stringify({ championship_id: championship.id, team_a_id: a.id, team_b_id: b.id, round }) }, true);
      const match = rows[0];
      const rosterRows = [...a.players, ...b.players].map(p=>({
        match_id: match.id,
        player_id: p.id,
        team_id: a.players.includes(p) ? a.id : b.id,
        starter: false, on_court: false, last_in_at: null
      }));
      if(rosterRows.length) await sb('match_players', { method:'POST', body: JSON.stringify(rosterRows) }, true);
    }
  }

  function pairWithBye(list){
    const shuffled = [...list].sort(()=>Math.random()-0.5);
    const pairs = [];
    for(let i=0;i+1<shuffled.length;i+=2) pairs.push([shuffled[i], shuffled[i+1]]);
    const bye = shuffled.length % 2 ? shuffled[shuffled.length-1] : null;
    return { pairs, bye };
  }

  // vencedor de um confronto encerrado (por placar ou W.O.) — usado pra saber quem segue vivo na
  // eliminatória. Confronto sem estatística nenhuma (0x0 real) não decide nada, fica de fora.
  function matchWinnerId(m){
    if(m.wo_winner_team_id) return m.wo_winner_team_id;
    if(!m.finished) return null;
    const scoreFor = teamId => m.match_stats.reduce((s,x)=>{
      const mp = m.match_players.find(p=>p.player_id===x.player_id);
      return mp && mp.team_id===teamId ? s+(x.pts||0) : s;
    }, 0);
    const a = scoreFor(m.team_a_id), b = scoreFor(m.team_b_id);
    if(a===b) return null;
    return a>b ? m.team_a_id : m.team_b_id;
  }

  // times que ainda não perderam nenhum confronto — inclui quem tirou bye (nunca jogou ainda).
  // Gerar a próxima rodada da eliminatória é sempre "pareia quem sobrou disso", nunca precisa
  // rastrear bye separadamente rodada a rodada.
  function champAliveTeams(teams, matches){
    const losers = new Set();
    matches.forEach(m=>{
      const winner = matchWinnerId(m);
      if(!winner) return;
      losers.add(winner===m.team_a_id ? m.team_b_id : m.team_a_id);
    });
    return teams.filter(t=>!losers.has(t.id));
  }

  // tabela de classificação (pontos corridos) — vitórias/derrotas por time, W.O. conta como jogo
  // vencido/perdido normal, saldo é só informativo (desempate).
  function champStandingsFromMatches(teams, matches){
    const byTeam = Object.fromEntries(teams.map(t=>[t.id, { id:t.id, name:t.name, gp:0, w:0, l:0, pf:0, pa:0 }]));
    const scoreFor = (m, teamId) => m.match_stats.reduce((s,x)=>{
      const mp = m.match_players.find(p=>p.player_id===x.player_id);
      return mp && mp.team_id===teamId ? s+(x.pts||0) : s;
    }, 0);
    matches.forEach(m=>{
      const winner = matchWinnerId(m);
      const a = byTeam[m.team_a_id], b = byTeam[m.team_b_id];
      if(!winner || !a || !b) return;
      const scoreA = scoreFor(m, m.team_a_id), scoreB = scoreFor(m, m.team_b_id);
      a.gp++; b.gp++; a.pf+=scoreA; a.pa+=scoreB; b.pf+=scoreB; b.pa+=scoreA;
      if(winner===a.id){ a.w++; b.l++; } else { b.w++; a.l++; }
    });
    return Object.values(byTeam).map(t=>({ ...t, sg:t.pf-t.pa })).sort((x,y)=> y.w-x.w || y.sg-x.sg || y.pf-x.pf);
  }

  async function finishChampMatch(matchId){
    try{
      const match = await fetchMatch(matchId);
      await freezeOnCourtPlayers(matchId, match);
      // trava o cronômetro no valor final em vez de deixar "rodando" num jogo já encerrado.
      await sbWrite(`matches?id=eq.${matchId}`, { method:'PATCH', body: JSON.stringify({ finished:true, clock_seconds: matchClockSeconds(match), clock_running_since: null }) }, 'Confronto encerrado', true);
      return true;
    }catch(e){ return false; }
  }

  // ---------- PLACAR PÚBLICO (link ?c=CODIGO&watch=MATCH_ID) ----------
  // Sem login, sem PIN — qualquer um com o link vê o confronto ao vivo, só leitura.
  // Reaproveita as classes visuais do Modo Quadra (court-diagram/court-chip) só pra exibir, sem drag nem clique.
  function openPublicStatModal(player, s, mp){
    document.getElementById('court-modal-name').textContent = `#${player.num||'—'} ${player.name}`;
    document.getElementById('court-modal-line').textContent = 'nesta partida';
    document.getElementById('court-modal-stats').innerHTML = `
      <div class="stat-btn" style="cursor:default;">${s.pts||0}<br>pontos</div>
      <div class="stat-btn" style="cursor:default;">${s.fg2m}/${s.fg2a}<br>2 pontos</div>
      <div class="stat-btn make" style="cursor:default;">${s.fg3m}/${s.fg3a}<br>3 pontos</div>
      <div class="stat-btn" style="cursor:default;">${s.ftm}/${s.fta}<br>lance livre</div>
      <div class="stat-btn" style="cursor:default;">${s.reb||0}<br>rebotes</div>
      <div class="stat-btn" style="cursor:default;">${s.ast||0}<br>assist.</div>
      <div class="stat-btn" style="cursor:default;">${s.stl||0}<br>roubos</div>
      <div class="stat-btn miss" style="cursor:default;">${s.pf||0}<br>faltas</div>
      <div class="stat-btn" style="cursor:default;">${fmtMinutes(mpSeconds(mp))}<br>em quadra</div>`;
    document.getElementById('court-stat-modal').classList.add('open');
  }

  function publicCourtHTML(team, roster, playersById, statOf){
    const onCourt = roster.filter(mp=>mp.on_court);
    const chips = onCourt.map((mp,i)=>{
      const p = playersById[mp.player_id]; if(!p) return '';
      const pos = COURT_SLOTS[i % COURT_SLOTS.length];
      const s = statOf(mp.player_id);
      return `<div class="court-chip" style="left:${pos[0]}%;top:${pos[1]}%;" data-pid="${p.id}"><span>${escapeHtml(p.num||'—')}</span><small>${s.pts||0}p</small></div>`;
    }).join('');
    return `
      <div class="court-diagram" style="height:180px;margin-bottom:10px;aspect-ratio:auto;">
        <div>${chips}</div>
      </div>`;
  }

  async function renderPublicMatch(code, matchId){
    const el = document.getElementById('champ-body');
    el.innerHTML = `<div class="panel"><div class="empty">Carregando placar…</div></div>`;

    let championship, teams, match;
    try{
      const snapshot = await fetchChampSnapshot(code);
      championship = snapshot && snapshot.championship;
      if(!championship) throw new Error('not found');
      teams = snapshot.teams;
      match = snapshot.matches.find(m=>m.id===matchId);
    }catch(e){
      el.innerHTML = champErrorHTML('Não foi possível carregar esse placar. Verifique o link ou a internet.');
      return;
    }
    if(!match){ el.innerHTML = champErrorHTML('Confronto não encontrado.'); return; }

    const teamA = teams.find(t=>t.id===match.team_a_id);
    const teamB = teams.find(t=>t.id===match.team_b_id);
    const playersById = Object.fromEntries([...(teamA?.players||[]), ...(teamB?.players||[])].map(p=>[p.id,p]));
    const statOf = pid => match.match_stats.find(s=>s.player_id===pid) || EMPTY_STAT;
    const mpOf = pid => match.match_players.find(mp=>mp.player_id===pid);
    const scoreOf = team => match.match_players.filter(mp=>mp.team_id===team.id).reduce((s,mp)=>s+(statOf(mp.player_id).pts||0),0);

    function statLine(mp, p){
      const s = statOf(mp.player_id);
      return `<div class="roster-row public-player-row" data-pid="${p.id}" style="cursor:pointer;"><span class="jersey">${escapeHtml(p.num||'—')}</span><span class="name">${escapeHtml(p.name)}</span><span style="color:var(--ink-dim);font-family:'JetBrains Mono';font-size:11px;white-space:nowrap;">${s.pts}p ${s.reb}r ${s.ast}a ${s.stl}rb ${s.pf}f · ${fmtMinutes(mpSeconds(mp))}</span></div>`;
    }
    function publicTeamPanel(team){
      const roster = match.match_players.filter(mp=>mp.team_id===team.id);
      // confronto encerrado: "em quadra" não quer dizer nada mais (é só quem tava lá no apito
      // final) — mostra o box score completo, todo mundo que jogou, com estatística e tempo final.
      // ao vivo: mantém a separação entre quem tá jogando agora e quem tá no banco.
      if(match.finished){
        const lines = roster.map(mp=>{ const p = playersById[mp.player_id]; return p ? statLine(mp, p) : ''; }).join('');
        return `
          <div class="panel">
            <span class="eyebrow">${escapeHtml(team.name)}</span>
            <div class="clock num" style="margin-bottom:10px;">${scoreOf(team)}</div>
            <div class="roster-list">${lines}</div>
          </div>`;
      }
      const bench = roster.filter(mp=>!mp.on_court).map(mp=>playersById[mp.player_id]).filter(Boolean);
      const lines = roster.filter(mp=>mp.on_court).map(mp=>{
        const p = playersById[mp.player_id]; return p ? statLine(mp, p) : '';
      }).join('');
      return `
        <div class="panel">
          <span class="eyebrow">${escapeHtml(team.name)}</span>
          <div class="clock num" style="margin-bottom:10px;">${scoreOf(team)}</div>
          ${publicCourtHTML(team, roster, playersById, statOf)}
          <div class="roster-list">${lines}</div>
          ${bench.length ? `<div class="eyebrow" style="margin-top:14px;">Banco</div><div style="color:var(--ink-dim);font-family:'JetBrains Mono';font-size:12px;">${bench.map(p=>`#${escapeHtml(p.num||'—')} ${escapeHtml(p.name)}`).join(' · ')}</div>` : ''}
        </div>`;
    }

    const backLabel = loadChampSession(code) ? '← voltar pro meu time' : '← sair do placar';
    el.innerHTML = `
      <button class="btn ghost" id="btn-public-back" style="margin-bottom:16px;">${backLabel}</button>
      <div class="panel">
        <span class="eyebrow">${match.finished ? 'Confronto encerrado' : '🔴 Ao vivo'} · ${escapeHtml(championship.name)}</span>
        <h2>${escapeHtml(teamA?.name||'?')} ${scoreOf(teamA)} × ${scoreOf(teamB)} ${escapeHtml(teamB?.name||'?')}</h2>
        <div class="num" style="font-size:20px;color:var(--ink-dim);">⏱ ${fmtMinutes(matchClockSeconds(match))}${match.clock_running_since ? '' : ' · pausado'}</div>
      </div>
      <div class="match-columns">
        ${publicTeamPanel(teamA)}
        ${publicTeamPanel(teamB)}
      </div>`;

    document.getElementById('btn-public-back').addEventListener('click', ()=>{
      const teamSession = loadChampSession(code);
      const url = new URL(location.href);
      url.searchParams.delete('watch');
      if(!teamSession) url.searchParams.delete('c');
      history.replaceState(null, '', url);
      if(teamSession && teamSession.teamId){
        champUI.teamId = teamSession.teamId; champUI.pin = teamSession.pin;
        renderChampTeamPanel();
      } else {
        switchView('scorer');
      }
    });
    el.querySelectorAll('.court-chip[data-pid], .public-player-row[data-pid]').forEach(node=>{
      node.addEventListener('click', ()=>{
        const p = playersById[node.dataset.pid];
        if(p) openPublicStatModal(p, statOf(p.id), mpOf(p.id));
      });
    });

    if(!match.finished){
      setTimeout(()=>{
        if(document.getElementById('view-champ')?.classList.contains('active') && watchParam()===matchId){
          renderPublicMatch(code, matchId);
        }
      }, 8000);
    }
  }

  async function renderMatchLive(championship, teams, matchId){
    const el = document.getElementById('champ-body');
    el.innerHTML = `<div class="panel"><div class="empty">Carregando confronto…</div></div>`;
    const match = await fetchMatch(matchId);
    const teamA = teams.find(t=>t.id===match.team_a_id);
    const teamB = teams.find(t=>t.id===match.team_b_id);
    const playersById = Object.fromEntries([...teamA.players, ...teamB.players].map(p=>[p.id,p]));

    function statOf(pid){ return match.match_stats.find(s=>s.player_id===pid) || EMPTY_STAT; }
    function mpOf(pid){ return match.match_players.find(mp=>mp.player_id===pid); }

    function teamScore(team){
      return match.match_players.filter(mp=>mp.team_id===team.id).reduce((sum,mp)=>sum+(statOf(mp.player_id).pts||0),0);
    }

    function teamColumn(team){
      const roster = match.match_players.filter(mp=>mp.team_id===team.id);
      const onCourt = roster.filter(mp=>mp.on_court);
      const bench = roster.filter(mp=>!mp.on_court);
      return `
        <div class="panel">
          <span class="eyebrow">${escapeHtml(team.name)}</span>
          <div class="clock num" style="margin-bottom:14px;">${teamScore(team)}</div>
          <div class="oncourt">
            ${onCourt.map(mp=>{
              const p = playersById[mp.player_id]; const s = statOf(mp.player_id);
              return `<div class="player-card">
                <div class="pname"><span class="jersey">${escapeHtml(p.num||'—')}</span><strong>${escapeHtml(p.name)}</strong></div>
                <div class="stat-grid">
                  ${statButtonsHTML(p.id)}
                </div>
                <div class="live-line">${statLineHTML(s, mpSeconds(mp))}</div>
                <button type="button" class="btn ghost sub-out" data-pid="${p.id}" style="margin-top:8px;width:100%;">↓ substituir (sai)</button>
              </div>`;
            }).join('')}
          </div>
          ${bench.length ? `
          <div class="eyebrow" style="margin-top:16px;">Banco de reservas</div>
          <div class="roster-list">
            ${bench.map(mp=>{
              const p = playersById[mp.player_id];
              return `<div class="roster-row">
                <span class="jersey">${escapeHtml(p.num||'—')}</span>
                <span class="name">${escapeHtml(p.name)}</span>
                <button type="button" class="btn sub-in" data-pid="${p.id}" style="color:var(--make);">↑ entra</button>
              </div>`;
            }).join('')}
          </div>` : ''}
        </div>`;
    }

    el.innerHTML = `
      <button class="btn ghost" id="btn-live-back" style="margin-bottom:16px;">← voltar (o confronto continua salvo, dá pra retomar depois)</button>
      <div class="panel">
        <span class="eyebrow">Confronto ao vivo</span>
        <h2>${escapeHtml(teamA.name)} ${teamScore(teamA)} × ${teamScore(teamB)} ${escapeHtml(teamB.name)}</h2>
        <div class="row" style="align-items:center;">
          <div id="live-clock" class="num" style="font-size:28px;min-width:90px;">${fmtMinutes(matchClockSeconds(match))}</div>
          <button class="btn" id="live-clock-start">▶ iniciar</button>
          <button class="btn" id="live-clock-pause" style="display:none;">⏸ pausar</button>
          <button class="btn ghost" id="live-clock-stop">⏹ parar</button>
        </div>
        <div class="row" style="margin-top:10px;">
          <button class="btn" id="btn-match-court-mode">🏀 Modo quadra</button>
          <button class="btn" id="btn-share-public">🔗 Compartilhar placar</button>
          <button class="btn primary" id="btn-finish-match">Encerrar confronto</button>
        </div>
        <div id="share-public-msg" style="margin-top:8px;font-family:'JetBrains Mono';font-size:12px;color:var(--ink-dim);"></div>
      </div>
      <div class="match-columns">
        ${teamColumn(teamA)}
        ${teamColumn(teamB)}
      </div>`;

    wireMatchClockControls('live', match, ()=> renderMatchLive(championship, teams, matchId));

    el.querySelectorAll('.stat-btn').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        btn.disabled = true;
        const changes = JSON.parse(btn.dataset.changes);
        const cur = statOf(btn.dataset.pid);
        const next = {...cur};
        Object.entries(changes).forEach(([k,v])=> next[k]=(next[k]||0)+v);
        try{
          await sbWrite(`match_stats?on_conflict=match_id,player_id`, {
            method:'POST',
            headers:{ Prefer:'resolution=merge-duplicates,return=representation' },
            body: JSON.stringify({ match_id: matchId, player_id: btn.dataset.pid, fg2m:next.fg2m, fg2a:next.fg2a, fg3m:next.fg3m, fg3a:next.fg3a, ftm:next.ftm, fta:next.fta, reb:next.reb, ast:next.ast, stl:next.stl, pf:next.pf })
          }, undefined, true);
          renderMatchLive(championship, teams, matchId);
        }catch(e){ btn.disabled = false; }
      });
    });
    el.querySelectorAll('.sub-out').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const mp = mpOf(btn.dataset.pid);
        try{
          await sbWrite(`match_players?match_id=eq.${matchId}&player_id=eq.${btn.dataset.pid}`, { method:'PATCH', body: JSON.stringify({ on_court:false, seconds_played: mpSeconds(mp), last_in_at:null }) }, 'Substituição feita', true);
          renderMatchLive(championship, teams, matchId);
        }catch(e){}
      });
    });
    el.querySelectorAll('.sub-in').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        try{
          await sbWrite(`match_players?match_id=eq.${matchId}&player_id=eq.${btn.dataset.pid}`, { method:'PATCH', body: JSON.stringify({ on_court:true, last_in_at:new Date().toISOString() }) }, 'Substituição feita', true);
          renderMatchLive(championship, teams, matchId);
        }catch(e){}
      });
    });
    document.getElementById('btn-finish-match').addEventListener('click', async ()=>{
      if(!confirm('Encerrar esse confronto?')) return;
      if(await finishChampMatch(matchId)) renderChampOverall(championship, true);
    });
    document.getElementById('btn-live-back').addEventListener('click', ()=> renderChampOverall(championship, true));
    document.getElementById('btn-match-court-mode').addEventListener('click', ()=>{
      openMatchCourtMode(championship, teamA, teamB, matchId);
    });
    document.getElementById('btn-share-public').addEventListener('click', ()=>{
      const link = `${location.origin}${location.pathname}?c=${championship.invite_code}&watch=${matchId}`;
      navigator.clipboard?.writeText(link).catch(()=>{});
      document.getElementById('share-public-msg').textContent = `Link copiado — qualquer um pode acompanhar ao vivo sem login: ${link}`;
    });
  }

  // Modo Quadra também pro confronto do organizador (dois times reais) — reaproveita o mesmo overlay
  // usado na súmula individual, com uma aba pra trocar de time em quadra.
  let matchCourtCtx = null;
  // quadra cheia: time A sempre na metade esquerda, time B na direita — nada de aba pra trocar,
  // os dois times ficam visíveis ao mesmo tempo, cada um com seu banco separado.
  // posição em quadra é pela FUNÇÃO do jogador (mesma formação do diagrama de referência), não
  // ordem aleatória: pivô sob a cesta, ala-pivô no garrafão, alas nas pontas, armador no topo do garrafão.
  const POSITION_SLOTS_LEFT = {
    'Pivô': [9,50],
    'Ala-pivô': [20,68],
    'Ala-armador': [34,20],
    'Ala': [34,80],
    'Armador': [46,50],
  };
  const POSITION_SLOTS_RIGHT = Object.fromEntries(Object.entries(POSITION_SLOTS_LEFT).map(([pos,[x,y]])=>[pos,[100-x,y]]));

  // quem tem posição cadastrada e vaga livre pega o lugar certo; o resto (sem posição, ou repetida)
  // preenche as vagas que sobrarem, pra nunca travar o desenho da quadra.
  function assignCourtSlots(onCourtIds, playersById, posSlots){
    const used = new Set();
    const result = {};
    onCourtIds.forEach(pid=>{
      const pos = playersById[pid]?.attrs?.position;
      if(pos && posSlots[pos] && !used.has(pos)){ result[pid] = posSlots[pos]; used.add(pos); }
    });
    const leftovers = Object.entries(posSlots).filter(([k])=>!used.has(k)).map(([,v])=>v);
    onCourtIds.forEach(pid=>{ if(!result[pid]) result[pid] = leftovers.shift() || [50,50]; });
    return result;
  }

  function openMatchCourtMode(championship, teamA, teamB, matchId){
    matchCourtCtx = { championship, teamA, teamB, matchId };
    document.getElementById('court-overlay').classList.add('open');
    document.querySelector('.court-bench').style.display = 'none';
    document.getElementById('court-bench-dual').classList.add('open');
    document.getElementById('court-label-left').textContent = teamA.name;
    document.getElementById('court-label-right').textContent = teamB.name;
    document.getElementById('court-bench-label-left').textContent = `Banco — ${teamA.name}`;
    document.getElementById('court-bench-label-right').textContent = `Banco — ${teamB.name}`;
    // botão de encerrar direto na quadra, sem precisar sair do modo — pedido explícito, antes só
    // dava pra encerrar voltando pra súmula. Reusa o mesmo botão do modo local, mas escondido lá.
    const finishBtn = document.getElementById('btn-court-finish-match');
    finishBtn.style.display = '';
    finishBtn.onclick = async ()=>{
      if(!confirm('Encerrar esse confronto?')) return;
      if(await finishChampMatch(matchId)){
        document.getElementById('court-overlay').classList.remove('open');
        matchCourtCtx = null;
        renderChampOverall(championship, true);
      }
    };
    document.getElementById('court-clock-controls').style.display = '';
    renderMatchCourtMode();
  }

  async function renderMatchCourtMode(){
    const ctx = matchCourtCtx;
    if(!ctx) return;
    let match;
    try{ match = await fetchMatch(ctx.matchId); }
    catch(e){ showToast('Falha ao carregar o confronto.', 'error'); return; }

    const statOf = pid => match.match_stats.find(s=>s.player_id===pid) || EMPTY_STAT;
    const scoreOf = teamId => match.match_stats.reduce((s,x)=>{
      const mp = match.match_players.find(p=>p.player_id===x.player_id);
      return mp && mp.team_id===teamId ? s + (x.pts||0) : s;
    },0);
    document.getElementById('court-score').textContent = `${ctx.teamA.name} ${scoreOf(ctx.teamA.id)} × ${scoreOf(ctx.teamB.id)} ${ctx.teamB.name}`;
    document.getElementById('court-score-left').textContent = scoreOf(ctx.teamA.id);
    document.getElementById('court-score-right').textContent = scoreOf(ctx.teamB.id);
    wireMatchClockControls('court', match, renderMatchCourtMode);

    const wrap = document.getElementById('court-players');
    wrap.innerHTML = '';
    [ [ctx.teamA, POSITION_SLOTS_LEFT, 'court-bench-left'], [ctx.teamB, POSITION_SLOTS_RIGHT, 'court-bench-right'] ].forEach(([team, posSlots, benchElId])=>{
      const playersById = Object.fromEntries(team.players.map(p=>[p.id,p]));
      const roster = match.match_players.filter(mp=>mp.team_id===team.id);
      const onCourtIds = roster.filter(mp=>mp.on_court).map(mp=>mp.player_id);
      const benchIds = roster.filter(mp=>!mp.on_court).map(mp=>mp.player_id);
      const slotByPid = assignCourtSlots(onCourtIds, playersById, posSlots);

      wrap.insertAdjacentHTML('beforeend', onCourtIds.map(pid=>{
        const p = playersById[pid]; if(!p) return '';
        const pos = slotByPid[pid];
        const s = statOf(pid);
        return `<div class="court-chip" style="left:${pos[0]}%;top:${pos[1]}%;" data-pid="${pid}" title="${escapeHtml(p.attrs?.position||'')}">
          <span>${escapeHtml(p.num||'—')}</span><small>${s.pts||0}p</small>
        </div>`;
      }).join(''));

      const benchList = document.getElementById(benchElId);
      benchList.innerHTML = benchIds.length
        ? benchIds.map(pid=>{ const p = playersById[pid]; return p ? `<div class="court-bench-chip" data-pid="${pid}">${escapeHtml(p.num||'—')}</div>` : ''; }).join('')
        : `<div style="color:var(--ink-dim);font-family:'JetBrains Mono';font-size:11px;">sem reservas</div>`;
      benchList.querySelectorAll('.court-bench-chip').forEach(chip=> enableMatchBenchDrag(chip));

      wrap.querySelectorAll('.court-chip').forEach(chip=>{
        if(chip.dataset.wired) return;
        chip.dataset.wired = '1';
        chip.addEventListener('click', ()=>{
          const allPlayersById = { ...Object.fromEntries(ctx.teamA.players.map(p=>[p.id,p])), ...Object.fromEntries(ctx.teamB.players.map(p=>[p.id,p])) };
          const mp = match.match_players.find(m=>m.player_id===chip.dataset.pid);
          openMatchStatModal(chip.dataset.pid, allPlayersById[chip.dataset.pid], statOf(chip.dataset.pid), mp);
        });
      });
    });
  }

  function enableMatchBenchDrag(chipEl){
    chipEl.addEventListener('pointerdown', e=>{
      e.preventDefault();
      const benchPid = chipEl.dataset.pid;
      const ghost = chipEl.cloneNode(true);
      ghost.style.position = 'fixed'; ghost.style.zIndex = '999'; ghost.style.pointerEvents = 'none'; ghost.style.opacity = '0.85';
      ghost.style.left = (e.clientX-22)+'px'; ghost.style.top = (e.clientY-22)+'px';
      document.body.appendChild(ghost);
      function clearHi(){ document.querySelectorAll('.court-chip.drag-over').forEach(c=>c.classList.remove('drag-over')); }
      function move(ev){
        ghost.style.left = (ev.clientX-22)+'px'; ghost.style.top = (ev.clientY-22)+'px';
        clearHi();
        const chip = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.court-chip');
        if(chip) chip.classList.add('drag-over');
      }
      async function up(ev){
        document.removeEventListener('pointermove', move);
        ghost.remove(); clearHi();
        const chip = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.court-chip');
        if(chip) await matchSubstitute(benchPid, chip.dataset.pid);
      }
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up, { once:true });
    });
  }

  async function matchSubstitute(benchPid, onCourtPid){
    const ctx = matchCourtCtx;
    if(!ctx || benchPid===onCourtPid) return;
    try{
      const match = await fetchMatch(ctx.matchId);
      const outMp = match.match_players.find(mp=>mp.player_id===onCourtPid);
      await sbWrite(`match_players?match_id=eq.${ctx.matchId}&player_id=eq.${onCourtPid}`, { method:'PATCH', body: JSON.stringify({ on_court:false, seconds_played: mpSeconds(outMp), last_in_at:null }) }, undefined, true);
      await sbWrite(`match_players?match_id=eq.${ctx.matchId}&player_id=eq.${benchPid}`, { method:'PATCH', body: JSON.stringify({ on_court:true, last_in_at:new Date().toISOString() }) }, 'Substituição feita', true);
      renderMatchCourtMode();
    }catch(e){}
  }

  function openMatchStatModal(pid, player, s, mp){
    const ctx = matchCourtCtx;
    document.getElementById('court-modal-name').textContent = `#${player.num||'—'} ${player.name}`;
    document.getElementById('court-modal-line').textContent = statLineHTML(s, mpSeconds(mp));
    const statsEl = document.getElementById('court-modal-stats');
    statsEl.innerHTML = statButtonsHTML(pid);
    statsEl.querySelectorAll('.stat-btn').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const changes = JSON.parse(btn.dataset.changes);
        const next = { ...EMPTY_STAT, ...s };
        Object.entries(changes).forEach(([k,v])=> next[k]=(next[k]||0)+v);
        try{
          await sbWrite(`match_stats?on_conflict=match_id,player_id`, {
            method:'POST',
            headers:{ Prefer:'resolution=merge-duplicates,return=representation' },
            body: JSON.stringify({ match_id: ctx.matchId, player_id: pid, fg2m:next.fg2m, fg2a:next.fg2a, fg3m:next.fg3m, fg3a:next.fg3a, ftm:next.ftm, fta:next.fta, reb:next.reb, ast:next.ast, stl:next.stl, pf:next.pf })
          }, undefined, true);
          const match = await fetchMatch(ctx.matchId);
          const newS = match.match_stats.find(x=>x.player_id===pid) || EMPTY_STAT;
          const newMp = match.match_players.find(x=>x.player_id===pid);
          openMatchStatModal(pid, player, newS, newMp);
          renderMatchCourtMode();
        }catch(e){}
      });
    });
    document.getElementById('court-stat-modal').classList.add('open');
  }

  // técnico convidado só cadastra o próprio elenco (titulares + reservas) — jogo, estatística, ranking e
  // gráfico ficam exclusivos com o organizador/scout. Nada de "premium" aparece aqui de propósito.
  // campos do cadastro de jogador no campeonato: reaproveita o mesmo ATTR_FIELDS do modo local
  // (app-core.js) pra manter os dados consistentes entre os dois modos. Posição/altura/peso são
  // obrigatórios; nascimento/envergadura/impulsão/velocidade ficam opcionais (nascimento não valia
  // tanto a pena travar o cadastro, pedido explícito).
  const CHAMP_REQUIRED_ATTRS = ['position','height','weight'];

  function champPlayerAttrFieldsHTML(){
    const today = new Date().toISOString().slice(0,10);
    return ATTR_FIELDS.map(f=>{
      const req = CHAMP_REQUIRED_ATTRS.includes(f.key);
      const limits = f.type==='date' ? `max="${today}"` : [f.min!=null?`min="${f.min}"`:'', f.max!=null?`max="${f.max}"`:''].join(' ');
      // campo type=date não mostra placeholder em boa parte dos navegadores (fica em branco sem
      // nenhuma pista do que é) — por isso ganha um <label> visível de verdade, e não só o texto
      // dentro do próprio input como os outros campos.
      const input = f.type==='select'
        ? `<select id="champ-attr-${f.key}" style="min-width:170px;"><option value="">${escapeHtml(f.label)}${req?' *':''}</option>${f.options.map(o=>`<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('')}</select>`
        : `<input type="${f.type}" id="champ-attr-${f.key}" placeholder="${escapeHtml(f.label)}${req?' *':''}" ${f.step?`step="${f.step}"`:''} ${limits} style="min-width:170px;">`;
      const label = f.type==='date' ? `<label style="display:block;font-size:11px;color:var(--ink-dim);margin-bottom:3px;">${escapeHtml(f.label)}${req?' *':''}</label>` : '';
      return `<div class="field" style="flex:1;margin:0;">${label}${input}</div>`;
    }).join('');
  }

  function readChampPlayerAttrs(){
    const attrs = {};
    ATTR_FIELDS.forEach(f=>{ const v = document.getElementById(`champ-attr-${f.key}`).value.trim(); if(v) attrs[f.key] = v; });
    return attrs;
  }

  async function renderChampTeamPanel(){
    const el = document.getElementById('champ-body');
    const championship = champUI.championship;
    el.innerHTML = `<div class="panel"><div class="empty">Carregando seu time…</div></div>`;
    let teams, matches;
    try{
      const snapshot = await fetchChampSnapshot(championship.invite_code);
      if(!snapshot) throw new Error('not found');
      teams = snapshot.teams; matches = snapshot.matches; champUI.championship = snapshot.championship;
    }catch(e){ el.innerHTML = champErrorHTML('Não deu pra conectar. Verifique a internet e volte a essa tela.'); return; }
    const myTeam = teams.find(t=>t.id===champUI.teamId);
    if(!myTeam){ el.innerHTML = champErrorHTML('Time não encontrado — o campeonato pode ter sido apagado.'); return; }
    const myMatches = matches.filter(m=>m.team_a_id===myTeam.id || m.team_b_id===myTeam.id);
    const archived = champUI.championship.archived;

    el.innerHTML = `
      <div class="panel">
        <span class="eyebrow">Campeonato · ${escapeHtml(championship.name)}</span>
        <h2>${escapeHtml(myTeam.name)}</h2>
        ${archived ? `<div style="color:var(--miss);font-size:13px;margin-bottom:8px;">🔒 Temporada encerrada pelo organizador — leitura apenas, não dá mais pra alterar o elenco.</div>` : ''}
        <div style="color:var(--ink-dim);font-size:12.5px;margin-bottom:12px;">Cadastre aqui o elenco do seu time. Você acompanha os jogos ao vivo (só visualização) — quem registra o jogo é o organizador.</div>
        <button class="btn ghost" id="btn-champ-leave">Sair deste time neste dispositivo</button>
      </div>

      <div class="panel" style="margin-top:16px;">
        <span class="eyebrow">Jogos</span>
        <h2>Confrontos do seu time</h2>
        <div class="roster-list">
          ${myMatches.length ? myMatches.map(m=>`
            <div class="roster-row">
              <span class="name">${escapeHtml(m.teamA.name)} × ${escapeHtml(m.teamB.name)}</span>
              <span style="color:var(--ink-dim);font-family:'JetBrains Mono';font-size:11px;">${m.finished?'encerrado':'🔴 ao vivo'}</span>
              <button type="button" class="btn champ-watch-match" data-mid="${m.id}">Acompanhar</button>
            </div>`).join('') : `<div class="empty">O organizador ainda não criou nenhum confronto com seu time.</div>`}
        </div>
      </div>

      <div class="panel" style="margin-top:16px;">
        <span class="eyebrow">Elenco</span>
        <h2>Jogadores</h2>
        ${archived ? '' : `
        <div class="row" style="margin-bottom:10px;">
          <input type="text" id="champ-player-name" placeholder="Nome do jogador *" style="flex:2;min-width:160px;">
          <input type="text" id="champ-player-num" placeholder="Nº *" style="max-width:80px;" inputmode="numeric">
        </div>
        <div class="row">
          ${champPlayerAttrFieldsHTML()}
        </div>
        <div style="color:var(--ink-dim);font-size:11px;margin:8px 0;">* campos obrigatórios: número da camisa, posição, altura e peso. Nascimento, envergadura, impulsão e velocidade são opcionais.</div>
        <button class="btn primary" id="champ-add-player">Adicionar jogador</button>
        <div id="champ-player-msg" style="margin-top:10px;font-family:'JetBrains Mono';font-size:12px;color:var(--miss);"></div>`}
        <div class="roster-list" id="champ-roster" style="margin-top:12px;">
          ${myTeam.players.length ? myTeam.players.map(p=>`
            <div class="roster-row">
              <span class="jersey">${escapeHtml(p.num||'—')}</span>
              <span class="name">${escapeHtml(p.name)}${p.attrs && p.attrs.position ? ` <span style="color:var(--ink-dim);font-size:11px;">${escapeHtml(p.attrs.position)}</span>` : ''}</span>
              ${archived ? '' : `<button type="button" class="icon-btn danger champ-remove-player" data-pid="${p.id}" title="Remover jogador">
                <svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"></line><line x1="18" y1="6" x2="6" y2="18"></line></svg>
              </button>`}
            </div>
          `).join('') : `<div class="empty">Nenhum jogador ainda.</div>`}
        </div>
      </div>`;

    document.getElementById('btn-champ-leave').addEventListener('click', ()=>{
      localStorage.removeItem(champSessionKey(championship.invite_code));
      champUI.teamId = null;
      renderChamp();
    });
    el.querySelectorAll('.champ-watch-match').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const url = new URL(location.href);
        url.searchParams.set('watch', btn.dataset.mid);
        history.replaceState(null, '', url);
        renderPublicMatch(champCode(), btn.dataset.mid);
      });
    });
    if(archived) return; // sem formulário de elenco pra travar nessa tela
    document.getElementById('champ-add-player').addEventListener('click', async (ev)=>{
      const btn = ev.currentTarget;
      if(btn.disabled) return;
      const name = document.getElementById('champ-player-name').value.trim();
      const num = document.getElementById('champ-player-num').value.trim();
      const msg = document.getElementById('champ-player-msg');
      const attrs = readChampPlayerAttrs();
      const missing = CHAMP_REQUIRED_ATTRS.filter(k=>!attrs[k]);
      if(!name){ msg.textContent = 'Preencha o nome do jogador.'; return; }
      if(!num){ msg.textContent = 'Preencha o número da camisa.'; return; }
      if(missing.length){ msg.textContent = 'Preencha posição, altura e peso — são obrigatórios.'; return; }
      msg.textContent = '';
      btn.disabled = true;
      try{
        // PIN do técnico validado no servidor (rpc_team_add_player) — antes ia direto pra tabela sem
        // provar nada, e qualquer anônimo com o team_id conseguia escrever no elenco de outro time.
        await sb('rpc/rpc_team_add_player', { method:'POST', body: JSON.stringify({ p_team_id: myTeam.id, p_pin: champUI.pin, p_name: name, p_num: num, p_attrs: attrs }) });
        renderChampTeamPanel();
      }catch(e){ msg.textContent = 'Erro ao adicionar jogador.'; btn.disabled = false; }
    });
    document.querySelectorAll('.champ-remove-player').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        if(btn.disabled) return;
        btn.disabled = true;
        try{
          await sb('rpc/rpc_team_remove_player', { method:'POST', body: JSON.stringify({ p_player_id: btn.dataset.pid, p_pin: champUI.pin }) });
          renderChampTeamPanel();
        }catch(e){ btn.disabled = false; }
      });
    });
  }

  if(champCode()) switchView('champ');
  // registro do SW foi movido pro <head> do index.html (rodar antes de tudo, ver comentário lá)
