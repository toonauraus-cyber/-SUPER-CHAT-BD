const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const views = ["homeView","authView","creatorView","adminView","publicView"];
let authMode = "login";
let currentSlug = null;
let socket = null;
let paymentMethods = [];
let currentProfile = null;
let toastTimer;

function toast(message) {
  const el = $("#toast"); el.textContent = message; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(()=>el.classList.remove("show"),3200);
}
function notice(id, message, error=false) {
  const el = $(id); if (!el) return;
  el.textContent = message || ""; el.classList.toggle("error", !!error);
}
async function api(url, options={}) {
  const response = await fetch(url, {
    credentials:"same-origin",
    headers: { "Content-Type":"application/json", ...(options.headers||{}) },
    ...options
  });
  const data = await response.json().catch(()=>({error:"Unexpected server response."}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}
function showView(id) {
  views.forEach(v=>$("#"+v).classList.toggle("hidden",v!==id));
  window.scrollTo({top:0,behavior:"smooth"});
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function money(n) { return "৳"+Number(n||0).toLocaleString("en-BD",{minimumFractionDigits:0,maximumFractionDigits:2}); }
function formatDate(v) { return new Date(v).toLocaleString("en-BD",{dateStyle:"medium",timeStyle:"short"}); }
function statusPill(status) { return `<span class="status ${escapeHtml(status)}">${escapeHtml(status)}</span>`; }
function table(headers, rows) {
  if (!rows.length) return `<div class="empty-state">Nothing to show yet.</div>`;
  return `<table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}
function goAuth(mode) {
  authMode=mode;
  $("#authTitle").textContent=mode==="register"?"Create your creator account":"Welcome back";
  $("#authSubtitle").textContent=mode==="register"?"Set up your own creator support page.":"Sign in to manage your creator page.";
  $("#nameField").classList.toggle("hidden",mode!=="register");
  $("#authSubmit").textContent=mode==="register"?"Create account":"Sign in";
  $("#authSwitch").innerHTML=mode==="register"?'Already registered? <button id="switchLogin">Sign in</button>':'New here? <button id="switchRegister">Create an account</button>';
  $("#authForm").reset(); notice("#authNotice","");
  showView("authView");
  $("#switchLogin")?.addEventListener("click",()=>goAuth("login"));
  $("#switchRegister")?.addEventListener("click",()=>goAuth("register"));
}
async function handleAuth(event) {
  event.preventDefault();
  const form=new FormData(event.currentTarget);
  const payload=Object.fromEntries(form.entries());
  const endpoint=authMode==="register"?"/api/auth/register":"/api/auth/login";
  try {
    const data=await api(endpoint,{method:"POST",body:JSON.stringify(payload)});
    await routeUser(data.user);
  } catch(e) { notice("#authNotice",e.message,true); }
}
async function routeUser(user) {
  if (!user) return showView("homeView");
  if (user.role==="admin") { showView("adminView"); await loadAdmin(); }
  else { showView("creatorView"); await loadCreator(); }
}
async function checkSession() {
  const data=await api("/api/me");
  if (data.user) await routeUser(data.user);
  else showView("homeView");
}
async function logout() {
  try { await api("/api/auth/logout",{method:"POST",body:"{}"}); }
  catch(e) { console.warn(e); }
  if(socket){socket.disconnect();socket=null;}
  currentSlug=null; showView("homeView"); toast("Signed out.");
}
function connectCreatorAlerts(slug) {
  if(socket) socket.disconnect();
  socket=io();
  socket.emit("creator:join",slug);
  socket.on("donation:verified",d=>{
    $("#alertAmount").textContent=money(d.amount);
    $("#alertFrom").textContent="From "+(d.donorName||"Anonymous");
    $("#alertMessage").textContent=d.message||"Thank you for your support!";
    $("#alertOverlay").classList.remove("hidden");
    loadCreator().catch(()=>{});
  });
}
async function loadCreator() {
  const data=await api("/api/creator/dashboard");
  currentProfile=data.profile; currentSlug=data.profile.slug;
  $("#creatorGreeting").textContent=data.profile.display_name;
  $("#statTotal").textContent=money(data.stats.total_verified);
  $("#statCount").textContent=data.stats.verified_count;
  $("#statPending").textContent=data.stats.pending_count;
  const url=location.origin+"/?creator="+encodeURIComponent(data.profile.slug);
  $("#creatorUrl").textContent=url;
  $("#publicPageLink").href=url;
  $("#profileForm").elements.displayName.value=data.profile.display_name||"";
  $("#profileForm").elements.bio.value=data.profile.bio||"";
  $("#profileForm").elements.avatarUrl.value=data.profile.avatar_url||"";
  $("#profileForm").elements.logoUrl.value=data.profile.logo_url||"";
  $("#profileForm").elements.bannerUrl.value=data.profile.banner_url||"";
  $("#profileForm").elements.themeColor.value=data.profile.theme_color||"#7657ff";
  $("#qrCode").innerHTML="";
  if(window.QRCode) new QRCode($("#qrCode"),{text:url,width:150,height:150,colorDark:"#10182b",colorLight:"#ffffff"});
  $("#availableBalance").textContent=money(Number(data.stats.total_verified)-data.withdrawals.filter(w=>["pending","approved","paid"].includes(w.status)).reduce((s,w)=>s+Number(w.amount),0));
  $("#withdrawMethod").innerHTML=data.withdrawalMethods.map(m=>`<option value="${escapeHtml(m.name)}">${escapeHtml(m.name)} — min ${money(m.min_amount)}</option>`).join("");
  $("#creatorDonations").innerHTML=table(["Supporter","Amount","Payment","Status","Date"],data.donations.map(d=>`<tr><td>${escapeHtml(d.donor_name)}</td><td>${money(d.amount)}</td><td>${escapeHtml(d.payment_method)}</td><td>${statusPill(d.status)}</td><td>${formatDate(d.created_at)}</td></tr>`));
  $("#creatorWithdrawals").innerHTML=table(["Amount","Method","Status","Date"],data.withdrawals.map(w=>`<tr><td>${money(w.amount)}</td><td>${escapeHtml(w.method)}</td><td>${statusPill(w.status)}</td><td>${formatDate(w.created_at)}</td></tr>`));
  connectCreatorAlerts(data.profile.slug);
}
async function saveProfile(e) {
  e.preventDefault();
  const f=Object.fromEntries(new FormData(e.currentTarget).entries());
  try { await api("/api/creator/profile",{method:"PUT",body:JSON.stringify(f)}); notice("#profileNotice","Profile saved successfully."); await loadCreator(); }
  catch(err){notice("#profileNotice",err.message,true);}
}
async function requestWithdrawal(e) {
  e.preventDefault(); const f=Object.fromEntries(new FormData(e.currentTarget).entries());
  try { const d=await api("/api/creator/withdrawals",{method:"POST",body:JSON.stringify(f)}); notice("#withdrawNotice",d.message); e.currentTarget.reset(); await loadCreator(); }
  catch(err){notice("#withdrawNotice",err.message,true);}
}
async function loadAdmin() {
  const [o,users,donations,pm,wm,withdrawals,settings]=await Promise.all([
    api("/api/admin/overview"),api("/api/admin/users"),api("/api/admin/donations"),
    api("/api/admin/payment-methods"),api("/api/admin/withdrawal-methods"),
    api("/api/admin/withdrawals"),api("/api/admin/settings")
  ]);
  $("#adminCreators").textContent=o.users.creators;
  $("#adminPending").textContent=o.donations.pending;
  $("#adminVerified").textContent=money(o.donations.verified_amount);
  $("#adminWithdrawPending").textContent=o.withdrawals.pending;
  $("#adminDonations").innerHTML=`<h2>Donation review</h2>`+donations.donations.map(d=>`
    <div class="admin-row"><div><strong>${money(d.amount)} · ${escapeHtml(d.donor_name)} → ${escapeHtml(d.creator_name)}</strong><small>${escapeHtml(d.payment_method)} · Ref: ${escapeHtml(d.transaction_reference)} · ${formatDate(d.created_at)} · ${statusPill(d.status)}</small><small>${escapeHtml(d.message)}</small></div>
    <div class="admin-actions">${d.status==="pending"?`<button class="approve" data-donation="${d.id}" data-status="verified">Verify & send live alert</button><button data-donation="${d.id}" data-status="rejected">Reject</button>`:"Reviewed"}</div></div>`).join("")||'<div class="empty-state">No donations yet.</div>';
  $("#adminCreatorsPanel").innerHTML="<h2>Creators & accounts</h2>"+users.users.map(u=>`<div class="admin-row"><div><strong>${escapeHtml(u.display_name||u.name)} · ${escapeHtml(u.email)}</strong><small>/${escapeHtml(u.slug||"admin")} · ${escapeHtml(u.role)} · ${statusPill(u.status)}</small></div><div class="admin-actions">${u.role==="creator"?`<button data-user="${u.id}" data-status="${u.status==="active"?"suspended":"active"}">${u.status==="active"?"Suspend":"Activate"}</button>`:"Platform admin"}</div></div>`).join("");
  $("#adminPayments").innerHTML=`<h2>Donation payment methods</h2><p class="muted small">These are collection methods shown to supporters. Keep a method disabled until its receiving account and instructions are configured.</p>`+pm.methods.map(m=>`
    <form class="method-form admin-row" data-payment-id="${m.id}">
      <div style="flex:1"><strong>${escapeHtml(m.name)}</strong><small>Supporter payment option</small></div>
      <div class="admin-form-grid" style="flex:3">
        <div class="field"><label>Receiving number / account</label><input name="accountNumber" value="${escapeHtml(m.account_number)}"></div>
        <div class="field"><label>Account type</label><input name="accountType" value="${escapeHtml(m.account_type)}"></div>
        <div class="field"><label>Instructions</label><input name="instructions" value="${escapeHtml(m.instructions)}"></div>
        <label class="checkline"><input name="enabled" type="checkbox" ${m.enabled?"checked":""}> Enabled</label>
        <button class="mini-btn">Save method</button>
      </div>
    </form>`).join("")+`<form id="addPaymentForm" class="admin-form-grid"><div class="field"><label>Add new collection method</label><input name="name" required placeholder="Method name"></div><div class="field"><label>Receiving account</label><input name="accountNumber"></div><div class="field"><label>Account type</label><input name="accountType" value="Personal"></div><div class="field"><label>Instructions</label><input name="instructions"></div><label class="checkline"><input type="checkbox" name="enabled"> Enable immediately</label><button class="btn btn-primary">Add method</button></form>`;
  $("#adminWithdrawals").innerHTML="<h2>Withdrawal requests</h2>"+withdrawals.withdrawals.map(w=>`<div class="admin-row"><div><strong>${money(w.amount)} · ${escapeHtml(w.creator_name)} (${escapeHtml(w.email)})</strong><small>${escapeHtml(w.method)} · ${escapeHtml(w.account_details)} · ${formatDate(w.created_at)} · ${statusPill(w.status)}</small></div><div class="admin-actions">${w.status==="pending"||w.status==="approved"?`<button data-withdrawal="${w.id}" data-status="approved">Approve</button><button data-withdrawal="${w.id}" data-status="paid">Mark paid</button><button data-withdrawal="${w.id}" data-status="rejected">Reject</button>`:"Reviewed"}</div></div>`).join("")||'<div class="empty-state">No withdrawal requests.</div>';
  $("#adminSettings").innerHTML=`<h2>Platform settings</h2><form id="settingsForm">${settings.settings.map(s=>`<div class="field"><label>${escapeHtml(s.key.replaceAll("_"," "))}</label><input name="${escapeHtml(s.key)}" value="${escapeHtml(s.value)}"></div>`).join("")}<button class="btn btn-primary">Save settings</button></form><div class="divider"></div><h2>Withdrawal method configuration</h2><p class="muted small">Creator payout methods, limits and fees. Pubali Bank is included as a bank transfer option.</p>`+wm.methods.map(m=>`<form class="withdraw-method-form admin-row" data-withdraw-id="${m.id}"><div><strong>${escapeHtml(m.name)}</strong><small>Creator payout option</small></div><div class="admin-form-grid" style="flex:3"><div class="field"><label>Minimum</label><input name="minAmount" type="number" min="1" value="${m.min_amount}"></div><div class="field"><label>Maximum</label><input name="maxAmount" type="number" min="1" value="${m.max_amount}"></div><div class="field"><label>Fee type</label><select name="feeType"><option value="fixed" ${m.fee_type==="fixed"?"selected":""}>Fixed BDT</option><option value="percent" ${m.fee_type==="percent"?"selected":""}>Percent</option></select></div><div class="field"><label>Fee value</label><input name="feeValue" type="number" min="0" step=".01" value="${m.fee_value}"></div><label class="checkline"><input name="enabled" type="checkbox" ${m.enabled?"checked":""}> Enabled</label><button class="mini-btn">Save limits</button></div></form>`).join("")+`<form id="addWithdrawForm" class="admin-form-grid"><div class="field"><label>Add withdrawal method</label><input name="name" required placeholder="Method name"></div><div class="field"><label>Minimum amount</label><input name="minAmount" type="number" value="100"></div><div class="field"><label>Maximum amount</label><input name="maxAmount" type="number" value="100000"></div><button class="btn btn-primary">Add method</button></form>`;
}
async function adminAction(url,method,body) {
  try { await api(url,{method,body:JSON.stringify(body)}); toast("Updated successfully."); await loadAdmin(); }
  catch(e){toast(e.message);}
}
async function openPublic(slug) {
  currentSlug=slug;
  try {
    const [data,methods]=await Promise.all([api("/api/public/creator/"+encodeURIComponent(slug)),api("/api/public/payment-methods")]);
    const p=data.profile; paymentMethods=methods.methods;
    $("#publicName").textContent=p.display_name; $("#supportCreatorName").textContent=p.display_name;
    $("#publicBio").textContent=p.bio||"Thanks for visiting my creator support page.";
    $("#publicAvatar").src=p.avatar_url||"data:image/svg+xml,"+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100%" height="100%" fill="#263553"/><text x="50%" y="56%" text-anchor="middle" fill="white" font-size="38">★</text></svg>');
    $("#publicLogo").classList.toggle("hidden",!p.logo_url);
    if(p.logo_url) $("#publicLogo").src=p.logo_url;
    $("#publicBanner").style.backgroundImage=p.banner_url?`linear-gradient(#080c1940,#080c1940),url("${p.banner_url.replace(/"/g,"")}")`:"linear-gradient(120deg,#242054,#15364a)";
    document.documentElement.style.setProperty("--purple",p.theme_color||"#7657ff");
    $("#publicPaymentMethods").innerHTML=paymentMethods.length?paymentMethods.map((m,i)=>`<label class="payment-option"><input type="radio" name="paymentMethod" value="${escapeHtml(m.name)}" ${i===0?"checked":""}><span>${escapeHtml(m.name)}</span></label>`).join(""):'<p class="muted">No payment methods are enabled yet.</p>';
    const renderInstructions=()=>{const m=paymentMethods.find(x=>x.name===$('input[name="paymentMethod"]:checked')?.value);const box=$("#paymentInstructions");if(m){box.classList.remove("hidden");box.innerHTML=`<strong>${escapeHtml(m.name)} ${m.account_type?"· "+escapeHtml(m.account_type):""}</strong><br>${m.account_number?`Send payment to: <b>${escapeHtml(m.account_number)}</b><br>`:""}${escapeHtml(m.instructions||"Follow the payment instructions provided by the creator.")}`;}else box.classList.add("hidden");};
    $$("#publicPaymentMethods input").forEach(el=>el.addEventListener("change",renderInstructions));renderInstructions();
    $("#publicSupporters").innerHTML=data.supporters.length?data.supporters.map(s=>`<div class="supporter-item"><div class="supporter-head"><strong>${escapeHtml(s.donor_name)}</strong><b>${money(s.amount)}</b></div><p>${escapeHtml(s.message||"Supported this creator ❤️")}</p><small>${formatDate(s.created_at)}</small></div>`).join(""):'<div class="empty-state">Be the first supporter in this community.</div>';
    showView("publicView");
  } catch(e){showView("homeView");toast(e.message);}
}
async function submitDonation(e) {
  e.preventDefault();
  const f=new FormData(e.currentTarget);
  const payload=Object.fromEntries(f.entries());
  payload.slug=currentSlug;payload.anonymous=f.get("anonymous")==="on";
  payload.paymentMethod=$('input[name="paymentMethod"]:checked')?.value||"";
  try {
    const d=await api("/api/public/donations",{method:"POST",body:JSON.stringify(payload)});
    notice("#donationNotice",d.message);e.currentTarget.reset();$$("#publicPaymentMethods input").forEach((el,i)=>el.checked=i===0);
    toast("Donation submitted for review.");
  } catch(err){notice("#donationNotice",err.message,true);}
}

$("#registerOpen").addEventListener("click",()=>goAuth("register"));
$("#loginOpen").addEventListener("click",()=>goAuth("login"));
$("#heroRegister").addEventListener("click",()=>goAuth("register"));
$("#backHome").addEventListener("click",()=>showView("homeView"));
$("#authForm").addEventListener("submit",handleAuth);
$("#profileForm").addEventListener("submit",saveProfile);
$("#withdrawForm").addEventListener("submit",requestWithdrawal);
$("#donationForm").addEventListener("submit",submitDonation);
$("#logoutCreator").addEventListener("click",logout);
$("#logoutAdmin").addEventListener("click",logout);
$("#closeAlert").addEventListener("click",()=>$("#alertOverlay").classList.add("hidden"));
$("#copyLink").addEventListener("click",async()=>{try{await navigator.clipboard.writeText($("#creatorUrl").textContent);toast("Creator link copied.");}catch(e){toast("Copy not available in this browser.");}});
$$(".amount-picks button").forEach(b=>b.addEventListener("click",()=>{$$(".amount-picks button").forEach(x=>x.classList.remove("selected"));b.classList.add("selected");$("#donationForm").elements.amount.value=b.dataset.amount;}));
$("#adminTabs").addEventListener("click",e=>{
  const tab=e.target.closest("[data-tab]");if(!tab)return;
  $$(".tab").forEach(t=>t.classList.toggle("active",t===tab));
  const map={donations:"adminDonations",creators:"adminCreatorsPanel",payments:"adminPayments",withdrawals:"adminWithdrawals",settings:"adminSettings"};
  Object.values(map).forEach(id=>$("#"+id).classList.add("hidden"));$("#"+map[tab.dataset.tab]).classList.remove("hidden");
});
document.addEventListener("click",e=>{
  const d=e.target.closest("[data-donation]");if(d)adminAction(`/api/admin/donations/${d.dataset.donation}`,"PATCH",{status:d.dataset.status});
  const u=e.target.closest("[data-user]");if(u)adminAction(`/api/admin/users/${u.dataset.user}/status`,"PATCH",{status:u.dataset.status});
  const w=e.target.closest("[data-withdrawal]");if(w)adminAction(`/api/admin/withdrawals/${w.dataset.withdrawal}`,"PATCH",{status:w.dataset.status});
});
document.addEventListener("submit",async e=>{
  if(e.target.matches(".method-form")){
    e.preventDefault();const f=new FormData(e.target);
    await adminAction(`/api/admin/payment-methods/${e.target.dataset.paymentId}`,"PUT",{
      accountNumber:f.get("accountNumber"),accountType:f.get("accountType"),instructions:f.get("instructions"),enabled:f.get("enabled")==="on"
    });
  }
  if(e.target.matches(".withdraw-method-form")){
    e.preventDefault();const f=new FormData(e.target);
    await adminAction(`/api/admin/withdrawal-methods/${e.target.dataset.withdrawId}`,"PUT",{
      minAmount:f.get("minAmount"),maxAmount:f.get("maxAmount"),feeType:f.get("feeType"),feeValue:f.get("feeValue"),enabled:f.get("enabled")==="on",
      name:e.target.querySelector("strong").textContent
    });
  }
  if(e.target.id==="addPaymentForm"){
    e.preventDefault();const f=new FormData(e.target);
    const payload=Object.fromEntries(f.entries());payload.enabled=f.get("enabled")==="on";
    await adminAction("/api/admin/payment-methods","POST",payload);
  }
  if(e.target.id==="addWithdrawForm"){
    e.preventDefault();const f=new FormData(e.target);
    await adminAction("/api/admin/withdrawal-methods","POST",Object.fromEntries(f.entries()));
  }
  if(e.target.id==="settingsForm"){
    e.preventDefault();await adminAction("/api/admin/settings","PUT",Object.fromEntries(new FormData(e.target).entries()));
  }
});
$("#year").textContent=new Date().getFullYear();

(async()=>{
  const params=new URLSearchParams(location.search);
  const slug=params.get("creator");
  if(slug){await openPublic(slug);return;}
  try{await checkSession();}catch(e){showView("homeView");}
})();
