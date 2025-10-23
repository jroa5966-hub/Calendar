import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  serverTimestamp,
  collection,
  query,
  where,
  onSnapshot,
  getDocs,
  deleteDoc,
  writeBatch,
  updateDoc
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-functions.js";

// initialize
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);

// UI refs
const authSection = document.getElementById('auth-section');
const appSection = document.getElementById('app');
const adminPanel = document.getElementById('admin-panel');
const loginBtn = document.getElementById('loginBtn');
const registerBtn = document.getElementById('registerBtn');
const logoutBtn = document.getElementById('logoutBtn');
const resetUserPasswordBtn = document.getElementById('resetUserPasswordBtn');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const adminOnlineCountEl = document.getElementById('admin-online-count');
const adminTotalCountEl = document.getElementById('admin-total-count');
const adminUsersListEl = document.getElementById('admin-users-list');
const refreshUsersBtn = document.getElementById('refreshUsersBtn');
const exportDataBtn = document.getElementById('exportDataBtn');
const authMessageEl = document.getElementById('auth-message');
const syncStatusEl = document.getElementById('sync-status');

// calendar refs
const calendarEl = document.getElementById('calendar');
const monthYearEl = document.getElementById('month-year');
const totalHoursEl = document.getElementById('total-hours');
const completionDateEl = document.getElementById('completion-date');
const prevMonthBtn = document.getElementById('prevMonthBtn');
const nextMonthBtn = document.getElementById('nextMonthBtn');
const resetBtn = document.getElementById('reset-btn');

// modal refs
const hoursModal = document.getElementById('hoursModal');
const modalBackdrop = document.getElementById('modalBackdrop');
const modalDateLabel = document.getElementById('modalDateLabel');
const modalHoursInput = document.getElementById('modalHoursInput');
const modalSaveBtn = document.getElementById('modalSaveBtn');
const modalCancelBtn = document.getElementById('modalCancelBtn');

// constants
const totalRequiredHours = 1800;
const hoursPerDayMax = 8;
const startDate = new Date(2025, 9, 1);
const minDate = new Date(2025, 9, 1);
const maxDate = new Date(2026, 11, 31);

let currentYear = startDate.getFullYear();
let currentMonth = startDate.getMonth();
let hoursData = {};
let currentUser = null;
let heartbeatTimer = null;
let presenceUnsub = null;
let modalCurrentDateStr = null;
let adminDashboardInitialized = false;
let previousHours = 0;

// helpers
function showAuthMessage(msg = '', type = 'info') {
  if (!authMessageEl) return;
  authMessageEl.textContent = msg;
  authMessageEl.style.color = (type === 'error') ? '#fecaca' : (type === 'success' ? '#bbf7d0' : '#94a3b8');
}
function showSyncStatus(text = '', visible = true) {
  if (!syncStatusEl) return;
  syncStatusEl.textContent = text;
  syncStatusEl.style.display = visible && text ? 'block' : 'none';
}
function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function monthName(mi) {
  return new Date(0, mi).toLocaleString(undefined, { month: 'long' });
}

// firestore refs
function userDataDocRef(uid) { return doc(db, 'users', uid, 'data', 'hours'); }
function userMetaDocRef(uid) { return doc(db, 'users', uid); }
function presenceDocRef(uid) { return doc(db, 'presence', uid); }

// load/save user data
async function loadUserData(uid) {
  hoursData = {};
  if (!uid) {
    updateCalendarAndSummary();
    return;
  }
  try {
    showSyncStatus('Loading...', true);
    const snap = await getDoc(userDataDocRef(uid));
    if (snap.exists()) {
      const data = snap.data();
      hoursData = data.hoursData || {};
    }
  } catch (e) {
    console.warn('loadUserData', e);
  }
  updateCalendarAndSummary();
  setTimeout(() => showSyncStatus('', false), 200);
}

async function saveUserData(uid) {
  if (!uid) return;
  try {
    showSyncStatus('Saving...', true);
    await setDoc(userDataDocRef(uid), { hoursData, updatedAt: serverTimestamp() }, { merge: true });
    showSyncStatus('Saved', true);
    setTimeout(() => showSyncStatus('', false), 900);
  } catch (e) {
    console.warn('saveUserData', e);
    showSyncStatus('Save failed', true);
    setTimeout(() => showSyncStatus('', false), 1600);
  }
}

// presence & meta
async function upsertUserMeta(user) {
  if (!user) return;
  try {
    await setDoc(userMetaDocRef(user.uid), {
      email: user.email || null,
      lastSeen: serverTimestamp(),
      createdAt: serverTimestamp()
    }, { merge: true });
  } catch (e) {
    console.warn('upsertUserMeta', e);
  }
}
async function setPresence(uid, email, online) {
  if (!uid) return;
  try {
    await setDoc(presenceDocRef(uid), { email: email || null, online: !!online, lastSeen: serverTimestamp() }, { merge: true });
  } catch (e) {
    console.warn('setPresence', e);
  }
}
function startHeartbeat(uid, email) {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => setPresence(uid, email, true).catch(console.error), 30000);
  setPresence(uid, email, true).catch(console.error);
}
function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

// registration (server callable with fallback)
async function registerUser(email, password) {
  if (!email || !password) {
    showAuthMessage('Enter email and password', 'error');
    return;
  }

  if (!firebaseConfig || !firebaseConfig.apiKey) {
    showAuthMessage('Configuration error: missing Firebase API key.', 'error');
    return;
  }

  showAuthMessage('Registering...', 'info');

  const SIGNUP_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${firebaseConfig.apiKey}`;

  try {
    const res = await fetch(SIGNUP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    });

    const data = await res.json();

    if (!res.ok) {
      const code = data?.error?.message || '';
      let friendly = 'Registration failed.';
      if (code.includes('EMAIL_EXISTS')) friendly = 'Email already in use.';
      else if (code.includes('INVALID_EMAIL')) friendly = 'Invalid email address.';
      else if (code.includes('WEAK_PASSWORD')) friendly = 'Password too weak (min 6 chars).';
      else if (code.includes('OPERATION_NOT_ALLOWED')) friendly = 'Email/password sign-in is disabled in Firebase.';
      showAuthMessage(friendly + (code ? ` (${code})` : ''), 'error');
      return;
    }

    // Sign in so onAuthStateChanged runs and app updates
    try {
      await signInWithEmailAndPassword(auth, email, password);
      showAuthMessage('Account created and signed in.', 'success');
    } catch (siErr) {
      console.warn('Signed up but sign-in failed:', siErr);
      showAuthMessage('Account created but sign-in failed. Try logging in.', 'info');
    }
  } catch (err) {
    console.error('registerUser (REST) error', err);
    showAuthMessage('Registration failed. Check network and console.', 'error');
  }
}

// login / logout
async function loginUser(email, password) {
  if (!email || !password) {
    showAuthMessage('Enter email and password', 'error');
    return;
  }
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    showAuthMessage('Signed in successfully.', 'success');
  } catch (error) {
    console.error('loginUser error', error);
    const code = error.code || 'unknown';
    const msg = error.message || String(error);
    showAuthMessage(`Error: ${code} — ${msg}`, 'error');
  }
}
function logoutUser() {
  if (currentUser && currentUser.uid) setPresence(currentUser.uid, currentUser.email, false).catch(console.error);
  stopHeartbeat();
  signOut(auth).catch(console.error);
}

// calendar UI
function generateCalendar(year, month) {
  calendarEl.innerHTML = '';
  monthYearEl.textContent = `${monthName(month)} ${year}`;

  const daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  daysOfWeek.forEach(d => {
    const h = document.createElement('div');
    h.className = 'day-header';
    h.textContent = d;
    calendarEl.appendChild(h);
  });

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const firstWeekday = firstDay.getDay();

  for (let i = 0; i < firstWeekday; i++) {
    const emptyCell = document.createElement('div');
    emptyCell.className = 'day disabled';
    calendarEl.appendChild(emptyCell);
  }

  for (let dayNum = 1; dayNum <= lastDay.getDate(); dayNum++) {
    const date = new Date(year, month, dayNum);
    const dateStr = formatDate(date);

    if (date < minDate || date > maxDate) {
      const disabledDay = document.createElement('div');
      disabledDay.className = 'day disabled';
      disabledDay.textContent = dayNum;
      calendarEl.appendChild(disabledDay);
      continue;
    }

    const dayDiv = document.createElement('div');
    dayDiv.className = 'day';

    if (date.getDay() === 0) {
      dayDiv.classList.add('sunday');
      dayDiv.textContent = dayNum;
    } else {
      dayDiv.innerHTML = `<div class="date-number">${dayNum}</div>`;
      dayDiv.tabIndex = 0;
      dayDiv.addEventListener('click', () => openHoursModal(date));
      dayDiv.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openHoursModal(date); }
      });
    }

    if (hoursData[dateStr] !== undefined) {
      const hrsDiv = document.createElement('div');
      hrsDiv.className = 'hours-entered';
      if (hoursData[dateStr] === 0) {
        hrsDiv.textContent = 'Absent';
        hrsDiv.style.color = '#ef4444';
        hrsDiv.style.fontWeight = '700';
      } else {
        hrsDiv.textContent = `${hoursData[dateStr]} hrs`;
        hrsDiv.style.color = '#2563eb';
      }
      dayDiv.appendChild(hrsDiv);
    }

    calendarEl.appendChild(dayDiv);
  }
}

function openHoursModal(date) {
  modalCurrentDateStr = formatDate(date);
  if (modalDateLabel) modalDateLabel.textContent = modalCurrentDateStr;
  const prev = hoursData[modalCurrentDateStr] !== undefined ? hoursData[modalCurrentDateStr] : '';
  if (modalHoursInput) modalHoursInput.value = (prev === '' || prev === undefined) ? '' : String(prev);
  if (hoursModal) { hoursModal.style.display = 'flex'; hoursModal.setAttribute('aria-hidden', 'false'); setTimeout(() => modalHoursInput?.focus(), 120); }
}
function closeHoursModal() {
  if (hoursModal) { hoursModal.style.display = 'none'; hoursModal.setAttribute('aria-hidden', 'true'); }
  modalCurrentDateStr = null;
  if (modalHoursInput) modalHoursInput.value = '';
}

// modal actions
modalCancelBtn?.addEventListener('click', () => closeHoursModal());
modalBackdrop?.addEventListener('click', () => closeHoursModal());
modalSaveBtn?.addEventListener('click', async () => {
  if (!modalCurrentDateStr) return closeHoursModal();
  let input = modalHoursInput?.value?.trim() ?? '';
  if (input === '') input = '0';
  const hrs = Number(input);
  if (isNaN(hrs) || hrs < 0 || hrs > hoursPerDayMax) {
    alert(`Please enter a number between 0 and ${hoursPerDayMax}.`);
    return;
  }
  hoursData[modalCurrentDateStr] = hrs === 0 ? 0 : hrs;
  updateCalendarAndSummary();
  if (currentUser && currentUser.uid) await saveUserData(currentUser.uid);
  closeHoursModal();
});

function getTotalHours() {
  return Object.values(hoursData).reduce((s, v) => (v > 0 ? s + v : s), 0);
}
function calculateCompletionDate() {
  const total = getTotalHours();
  if (total >= totalRequiredHours) return '🎉 Completed!';
  const left = totalRequiredHours - total;
  const daysNeeded = Math.ceil(left / hoursPerDayMax);

  let lastDate = startDate;
  if (Object.keys(hoursData).length > 0) {
    const dates = Object.keys(hoursData).sort();
    lastDate = new Date(dates[dates.length - 1]);
  }

  let completion = new Date(lastDate);
  let counted = 0;
  while (counted < daysNeeded) {
    completion.setDate(completion.getDate() + 1);
    if (completion.getDay() !== 0) counted++;
  }
  return completion.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}
function updateCalendarAndSummary() {
  generateCalendar(currentYear, currentMonth);
  // include previousHours in displayed total
  const total = getTotalHours() + (previousHours || 0);
  if (totalHoursEl) totalHoursEl.textContent = String(Number(total.toFixed(1)));
  if (completionDateEl) completionDateEl.textContent = calculateCompletionDate();
  if (currentUser && currentUser.uid) saveUserData(currentUser.uid);
}

// navigation
prevMonthBtn?.addEventListener('click', () => {
  if (currentYear === minDate.getFullYear() && currentMonth === minDate.getMonth()) return;
  currentMonth--;
  if (currentMonth < 0) { currentMonth = 11; currentYear--; }
  updateCalendarAndSummary();
});
nextMonthBtn?.addEventListener('click', () => {
  if (currentYear === maxDate.getFullYear() && currentMonth === maxDate.getMonth()) return;
  currentMonth++;
  if (currentMonth > 11) { currentMonth = 0; currentYear++; }
  updateCalendarAndSummary();
});
resetBtn?.addEventListener('click', () => {
  if (confirm('Clear all entries?')) {
    hoursData = {};
    if (currentUser && currentUser.uid) saveUserData(currentUser.uid);
    updateCalendarAndSummary();
  }
});

// auth wiring
loginBtn?.addEventListener('click', () => loginUser(emailInput.value.trim(), passwordInput.value.trim()));
registerBtn?.addEventListener('click', () => registerUser(emailInput.value.trim(), passwordInput.value.trim()));
logoutBtn?.addEventListener('click', () => logoutUser());
resetUserPasswordBtn?.addEventListener('click', async () => {
  const email = prompt('Enter your email for reset:');
  if (!email) return;
  try { await sendPasswordResetEmail(auth, email); alert('Reset sent.'); } catch (e) { alert(e.message); }
});

// export data
exportDataBtn?.addEventListener('click', () => {
  const who = currentUser && currentUser.email ? currentUser.email.replace(/[@.]/g, '_') : 'guest';
  const dataStr = JSON.stringify({ hoursData }, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hours-${who}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// admin presence
function startPresenceListener() {
  presenceUnsub = onSnapshot(collection(db, 'presence'), snapshot => {
    const onlineCount = snapshot.docs.filter(d => d.data().online).length;
    if (adminOnlineCountEl) {
      adminOnlineCountEl.textContent = String(onlineCount);
    }

    // Update status indicators
    snapshot.docChanges().forEach(change => {
      const uid = change.doc.id;
      const data = change.doc.data();
      const userEl = adminUsersListEl?.querySelector(`[data-uid="${uid}"] .status-indicator`);
      if (userEl) {
        userEl.className = `status-indicator ${data.online ? 'status-online' : 'status-offline'}`;
      }
    });
  });
}
function stopPresenceListener() { if (presenceUnsub) { presenceUnsub(); presenceUnsub = null; if (adminOnlineCountEl) adminOnlineCountEl.textContent = '0'; } }

function initAdminDashboard() {
  if (!adminPanel || adminDashboardInitialized) return;
  
  const dashboardHTML = `
    <div class="admin-dashboard">
      <div class="admin-header">
        <h2>Admin Dashboard</h2>
        <div class="stats-grid">
          <div class="stat-card">
            <span>Total Users</span>
            <strong id="admin-total-count">0</strong>
          </div>
          <div class="stat-card">
            <span>Online Now</span>
            <strong id="admin-online-count">0</strong>
          </div>
        </div>
      </div>
      
      <div class="users-container">
        <div class="users-header">
          <h3>Registered Users</h3>
          <button id="refresh-users" class="btn primary">
            <i class="fas fa-sync"></i> Refresh List
          </button>
        </div>
        <div id="admin-users-list" class="users-grid"></div>
      </div>
    </div>
  `;
  
  adminPanel.innerHTML = dashboardHTML;
  adminDashboardInitialized = true;
}

// Replace the existing fetchUsersForAdmin function
async function fetchUsersForAdmin() {
  if (!adminUsersListEl) return;
  adminUsersListEl.innerHTML = '<div class="loading">Loading users...</div>';
  
  try {
    const usersSnapshot = await getDocs(collection(db, 'users'));
    const users = [];
    usersSnapshot.forEach(doc => {
      users.push({ id: doc.id, ...doc.data() });
    });

    adminUsersListEl.innerHTML = '';
    
    users.forEach(user => {
      const userCard = document.createElement('div');
      userCard.className = 'user-card';
      userCard.innerHTML = `
        <div class="user-info">
          <span class="status-dot ${user.online ? 'online' : 'offline'}"></span>
          <span class="user-email">${user.email || 'No email'}</span>
        </div>
        <button class="action-btn delete-btn" title="Delete User">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
            <line x1="10" y1="11" x2="10" y2="17"/>
            <line x1="14" y1="11" x2="14" y2="17"/>
          </svg>
        </button>
      `;

      userCard.querySelector('.delete-btn').onclick = async (e) => {
        if (!confirm(`Delete user ${user.email}?`)) return;
        
        try {
          // Simple delete using REST API
          const idToken = await currentUser.getIdToken();
          await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${firebaseConfig.apiKey}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${idToken}`
            },
            body: JSON.stringify({ localId: user.id })
          });

          // Remove from Firestore
          await deleteDoc(doc(db, 'users', user.id));
          await deleteDoc(doc(db, 'presence', user.id));
          
          userCard.remove();
          updateUserCounts();
        } catch (err) {
          console.error('Delete failed:', err);
          alert('Failed to delete user');
        }
      };

      adminUsersListEl.appendChild(userCard);
    });
    
    updateUserCounts();
  } catch (err) {
    console.error('Fetch users error:', err);
    adminUsersListEl.innerHTML = '<div class="error">Failed to load users</div>';
  }
}

function updateUserCounts() {
  const totalUsers = adminUsersListEl.querySelectorAll('.user-card').length;
  const onlineUsers = adminUsersListEl.querySelectorAll('.status-dot.online').length;
  
  if (adminTotalCountEl) adminTotalCountEl.textContent = totalUsers;
  if (adminOnlineCountEl) adminOnlineCountEl.textContent = onlineUsers;
}

// auth state
onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    if (authSection) authSection.style.display = 'none';
    if (appSection) appSection.style.display = 'block';

    await upsertUserMeta(user);
    // load saved previousHours from user's meta doc
    try {
      const metaSnap = await getDoc(userMetaDocRef(user.uid));
      previousHours = metaSnap.exists() ? (metaSnap.data().previousHours || 0) : 0;
    } catch (e) {
      console.warn('load previousHours', e);
      previousHours = 0;
    }

    await loadUserData(user.uid);
    await setPresence(user.uid, user.email, true);
    startHeartbeat(user.uid, user.email);

    const token = await user.getIdTokenResult(true);
    const isAdmin = !!token.claims?.admin;
    if (isAdmin) {
      if (adminPanel) adminPanel.style.display = 'block';
      startPresenceListener();
      fetchUsersForAdmin();
    } else {
      if (adminPanel) adminPanel.style.display = 'none';
      stopPresenceListener();
    }
  } else {
    currentUser = null;
    if (authSection) authSection.style.display = 'block';
    if (appSection) appSection.style.display = 'none';
    hoursData = {};
    previousHours = 0; // reset
    updateCalendarAndSummary();
    stopHeartbeat();
    stopPresenceListener();
  }
});

// initial render
updateCalendarAndSummary();

// Add this CSS to your styles.css first
const adminStyles = document.createElement('style');
adminStyles.textContent = `
  .admin-user-item {
    display: flex;
    align-items: center;
    padding: 12px;
    background: rgba(255,255,255,0.03);
    border-radius: 8px;
    margin-bottom: 8px;
  }
  .status-indicator {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    margin-right: 12px;
  }
  .status-online {
    background: #22c55e;
    box-shadow: 0 0 8px rgba(34,197,94,0.4);
  }
  .status-offline {
    background: #ef4444;
    box-shadow: 0 0 8px rgba(239,68,68,0.2);
  }
  .user-email {
    flex: 1;
  }
  .delete-user-btn {
    padding: 6px 12px;
    background: #dc2626;
    color: white;
    border: none;
    border-radius: 6px;
    cursor: pointer;
  }
  .delete-user-btn:hover {
    background: #b91c1c;
  }
`;
document.head.appendChild(adminStyles);

async function deleteUser(uid, email) {
  if (!confirm(`Delete user ${email}?`)) return;

  try {
    // First check if current user is admin
    const currentUserDoc = await getDoc(doc(db, 'users', auth.currentUser.uid));
    if (!currentUserDoc.data()?.isAdmin) {
      throw new Error('Only admins can delete users');
    }

    // Delete user documents
    const batch = writeBatch(db);
    batch.delete(doc(db, 'users', uid));
    batch.delete(doc(db, 'presence', uid));
    batch.delete(doc(db, 'userData', uid));
    await batch.commit();

    // Delete auth user
    const deleteUserFn = httpsCallable(functions, 'deleteUser');
    await deleteUserFn({ uid });

    // Update UI
    const userElement = document.querySelector(`[data-uid="${uid}"]`);
    if (userElement) {
      userElement.remove();
      updateUserCounts();
    }

    showMessage('User deleted successfully', 'success');
  } catch (err) {
    console.error('Delete failed:', err);
    showMessage(err.message || 'Failed to delete user', 'error');
  }
}

// Add/update these functions
async function refreshUsersList() {
  if (!adminUsersListEl) return;
  
  // Show loading state
  adminUsersListEl.innerHTML = '<div class="loading">Refreshing users list...</div>';
  
  try {
    // Get fresh users data
    const usersQuery = query(collection(db, 'users'));
    const usersSnap = await getDocs(usersQuery);
    
    // Get presence data
    const presenceQuery = query(collection(db, 'presence'));
    const presenceSnap = await getDocs(presenceQuery);
    
    // Build presence map
    const presenceMap = new Map();
    presenceSnap.forEach(doc => {
      const data = doc.data();
      presenceMap.set(doc.id, {
        online: !!data.online,
        lastSeen: data.lastSeen
      });
    });
    
    // Clear and rebuild users list
    adminUsersListEl.innerHTML = '';
    let totalUsers = 0;
    let onlineUsers = 0;

    usersSnap.forEach(doc => {
      const userData = doc.data();
      const presence = presenceMap.get(doc.id);
      const isOnline = !!presence?.online;
      
      totalUsers++;
      if (isOnline) onlineUsers++;

      const userCard = document.createElement('div');
      userCard.className = 'user-card';
      userCard.dataset.uid = doc.id;
      
      userCard.innerHTML = `
        <div class="user-info">
          <span class="status-dot ${isOnline ? 'online' : 'offline'}" 
                title="${isOnline ? 'Online' : 'Offline'}"></span>
          <span class="user-email">${userData.email || 'No email'}</span>
        </div>
        <button class="delete-btn" onclick="deleteUser('${doc.id}', '${userData.email}')">
          Delete
        </button>
      `;
      
      adminUsersListEl.appendChild(userCard);
    });

    // Update counters
    if (adminTotalCountEl) adminTotalCountEl.textContent = totalUsers;
    if (adminOnlineCountEl) adminOnlineCountEl.textContent = onlineUsers;

    // Show success message
    showMessage('Users list refreshed', 'success');

  } catch (err) {
    console.error('Refresh failed:', err);
    adminUsersListEl.innerHTML = '<div class="error">Failed to refresh users list</div>';
    showMessage('Failed to refresh users list', 'error');
  }
}

// Add event listener to refresh button
const refreshBtn = document.getElementById('refresh-users');
if (refreshBtn) {
  refreshBtn.addEventListener('click', () => {
    refreshBtn.disabled = true;
    refreshBtn.innerHTML = '<span class="loader"></span> Refreshing...';
    
    refreshUsersList().finally(() => {
      refreshBtn.disabled = false;
      refreshBtn.innerHTML = '<i class="fas fa-sync"></i> Refresh';
    });
  });
}

// Helper function to show temporary messages
function showMessage(text, type = 'info') {
  const msg = document.createElement('div');
  msg.className = `message ${type}`;
  msg.textContent = text;
  document.body.appendChild(msg);
  setTimeout(() => msg.remove(), 3000);
}

function addPreviousHoursButton() {
  const summaryCard = document.querySelector('.summary-card');
  if (!summaryCard) return;
  // avoid adding button multiple times
  if (document.getElementById('prev-hours-btn')) return;

  const prevHoursBtn = document.createElement('button');
  prevHoursBtn.id = 'prev-hours-btn';
  prevHoursBtn.className = 'btn primary';
  prevHoursBtn.style.width = '100%';
  prevHoursBtn.style.marginTop = '12px';
  prevHoursBtn.innerHTML = '<i class="fas fa-clock"></i> Enter Previous Hours';
  prevHoursBtn.addEventListener('click', showPreviousHoursModal);

  summaryCard.appendChild(prevHoursBtn);
}

function showPreviousHoursModal() {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-card" role="dialog" aria-modal="true">
      <h3>Enter Previous Hours</h3>
      <p class="muted">Enter your total hours before using this system</p>
      <form id="previous-hours-form" class="previous-hours-form">
        <div class="hours-input-wrapper">
          <input type="number"
                 id="prev-hours-input"
                 min="0"
                 step="0.5"
                 required
                 placeholder="Enter hours..."
                 class="hours-input" />
        </div>
        <div class="modal-actions">
          <button type="button" class="btn ghost" id="prev-hours-cancel">Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);

  const form = modal.querySelector('#previous-hours-form');
  const cancelBtn = modal.querySelector('#prev-hours-cancel');
  const input = modal.querySelector('#prev-hours-input');

  cancelBtn.addEventListener('click', () => modal.remove());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = input.value;
    const hours = parseFloat(raw);
    if (isNaN(hours) || hours < 0) {
      alert('Please enter a valid number of hours (>= 0).');
      return;
    }
    if (!auth.currentUser) {
      alert('Not signed in.');
      return;
    }

    try {
      const userRef = doc(db, 'users', auth.currentUser.uid);
      await setDoc(userRef, { previousHours: hours, lastUpdated: serverTimestamp() }, { merge: true });
      previousHours = hours; // update in-memory value
      updateCalendarAndSummary();
      showMessage('Previous hours saved', 'success');
      modal.remove();
    } catch (err) {
      console.error('Save previous hours failed', err);
      alert('Failed to save previous hours. Check console.');
    }
  });

  // focus input
  setTimeout(() => input.focus(), 100);
}

async function updateTotalHours() {
  try {
    // previousHours is loaded on sign-in into the in-memory variable
    const current = getTotalHours();
    const total = (previousHours || 0) + current;
    if (totalHoursEl) totalHoursEl.textContent = Number(total.toFixed(1)).toString();
  } catch (err) {
    console.error('Error updating total hours', err);
  }
}

// Add this to your auth state change handler
onAuthStateChanged(auth, user => {
  if (user) {
    addPreviousHoursButton();
  }
});
