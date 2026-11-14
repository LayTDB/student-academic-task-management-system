const $ = (selector) => document.querySelector(selector);
const tokenKey = "satm_token";
const userKey = "satm_user";

let token = localStorage.getItem(tokenKey);
let user = JSON.parse(localStorage.getItem(userKey) || "null");
let authMode = "login";

function showMessage(el, text, ok = false) {
  el.textContent = text || "";
  el.style.color = ok ? "#166534" : "#b91c1c";
}

function setAuthMode(mode) {
  authMode = mode;
  $("#loginTab").classList.toggle("active", mode === "login");
  $("#signupTab").classList.toggle("active", mode === "signup");
  $("#nameField").classList.toggle("hidden", mode !== "signup");
  $("#authSubmit").textContent = mode === "login" ? "Login" : "Create Account";
  $("#password").autocomplete = mode === "login" ? "current-password" : "new-password";
  showMessage($("#authMessage"), "");
}

async function api(url, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401) logout(false);
    throw new Error(data.message || "Something went wrong.");
  }
  return data;
}

function saveSession(data) {
  token = data.token;
  user = data.user;
  localStorage.setItem(tokenKey, token);
  localStorage.setItem(userKey, JSON.stringify(user));
  showApp();
}

function logout(redirect = true) {
  token = null;
  user = null;
  localStorage.removeItem(tokenKey);
  localStorage.removeItem(userKey);
  if (redirect) showAuth();
}

function showAuth() {
  $("#authView").classList.remove("hidden");
  $("#appView").classList.add("hidden");
}

async function showApp() {
  $("#authView").classList.add("hidden");
  $("#appView").classList.remove("hidden");
  $("#welcomeText").textContent = user ? `Welcome, ${user.name}` : "";
  await Promise.all([loadDashboard(), loadSubjects(), loadTasks()]);
}

$("#loginTab").addEventListener("click", () => setAuthMode("login"));
$("#signupTab").addEventListener("click", () => setAuthMode("signup"));
$("#logoutBtn").addEventListener("click", () => logout());

$("#authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    email: $("#email").value,
    password: $("#password").value
  };
  if (authMode === "signup") payload.name = $("#name").value;

  try {
    const endpoint = authMode === "login" ? "/api/auth/login" : "/api/auth/signup";
    const data = await api(endpoint, { method: "POST", body: JSON.stringify(payload) });
    saveSession(data);
  } catch (err) {
    showMessage($("#authMessage"), err.message);
  }
});

async function loadDashboard() {
  const data = await api("/api/dashboard");
  $("#totalStat").textContent = data.total;
  $("#pendingStat").textContent = data.pending;
  $("#completedStat").textContent = data.completed;
  $("#overdueStat").textContent = data.overdue;
}

async function loadSubjects() {
  const data = await api("/api/subjects");
  const select = $("#taskSubject");
  select.innerHTML = '<option value="">No subject</option>';
  for (const subject of data.subjects) {
    const option = document.createElement("option");
    option.value = subject.id;
    option.textContent = subject.name;
    select.appendChild(option);
  }

  const list = $("#subjectList");
  list.innerHTML = "";
  if (!data.subjects.length) {
    list.innerHTML = '<p class="muted">No subjects yet.</p>';
    return;
  }

  for (const subject of data.subjects) {
    const item = document.createElement("div");
    item.className = "subject";
    item.innerHTML = `<span>${escapeHtml(subject.name)}</span><button title="Delete subject">×</button>`;
    item.querySelector("button").addEventListener("click", async () => {
      if (!confirm(`Delete "${subject.name}"? Tasks will remain but lose this subject.`)) return;
      try {
        await api(`/api/subjects/${subject.id}`, { method: "DELETE" });
        await Promise.all([loadSubjects(), loadTasks(), loadDashboard()]);
      } catch (err) {
        alert(err.message);
      }
    });
    list.appendChild(item);
  }
}

$("#subjectForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/subjects", {
      method: "POST",
      body: JSON.stringify({ name: $("#subjectName").value })
    });
    $("#subjectName").value = "";
    await loadSubjects();
  } catch (err) {
    alert(err.message);
  }
});

$("#taskForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: $("#taskTitle").value,
        description: $("#taskDescription").value,
        subjectId: $("#taskSubject").value || null,
        deadline: $("#taskDeadline").value || null
      })
    });
    event.target.reset();
    showMessage($("#taskMessage"), "Task added successfully.", true);
    await Promise.all([loadTasks(), loadDashboard()]);
  } catch (err) {
    showMessage($("#taskMessage"), err.message);
  }
});

$("#searchInput").addEventListener("input", debounce(loadTasks, 250));
$("#statusFilter").addEventListener("change", loadTasks);

async function loadTasks() {
  const params = new URLSearchParams();
  if ($("#searchInput").value.trim()) params.set("search", $("#searchInput").value.trim());
  if ($("#statusFilter").value) params.set("status", $("#statusFilter").value);

  const data = await api(`/api/tasks?${params.toString()}`);
  const list = $("#taskList");
  list.innerHTML = "";

  if (!data.tasks.length) {
    list.innerHTML = '<div class="empty">No tasks found.</div>';
    return;
  }

  for (const task of data.tasks) {
    const item = document.createElement("article");
    item.className = `task ${task.status === "completed" ? "completed" : ""}`;

    const deadline = task.deadline ? new Date(task.deadline) : null;
    const isOverdue = deadline && task.status === "pending" && deadline.getTime() < Date.now();

    item.innerHTML = `
      <div class="task-top">
        <div>
          <div class="task-title">${escapeHtml(task.title)}</div>
          <span class="badge">${escapeHtml(task.subject_name || "No subject")}</span>
        </div>
        <span class="badge ${isOverdue ? "overdue" : ""}">${isOverdue ? "Overdue" : task.status}</span>
      </div>
      ${task.description ? `<div class="task-desc">${escapeHtml(task.description)}</div>` : ""}
      <div class="task-meta">
        <span>${deadline ? `Deadline: ${deadline.toLocaleString()}` : "No deadline"}</span>
      </div>
      <div class="task-actions">
        <button data-action="toggle">${task.status === "completed" ? "Mark Pending" : "Mark Complete"}</button>
        <button data-action="edit">Edit</button>
        <button data-action="delete">Delete</button>
      </div>
    `;

    item.querySelector('[data-action="toggle"]').addEventListener("click", async () => {
      try {
        await api(`/api/tasks/${task.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: task.status === "completed" ? "pending" : "completed" })
        });
        await Promise.all([loadTasks(), loadDashboard()]);
      } catch (err) {
        alert(err.message);
      }
    });

    item.querySelector('[data-action="edit"]').addEventListener("click", async () => {
      const title = prompt("Task title:", task.title);
      if (title === null) return;
      const description = prompt("Description:", task.description || "");
      if (description === null) return;

      try {
        await api(`/api/tasks/${task.id}`, {
          method: "PATCH",
          body: JSON.stringify({ title, description })
        });
        await loadTasks();
      } catch (err) {
        alert(err.message);
      }
    });

    item.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      if (!confirm(`Delete "${task.title}"?`)) return;
      try {
        await api(`/api/tasks/${task.id}`, { method: "DELETE" });
        await Promise.all([loadTasks(), loadDashboard()]);
      } catch (err) {
        alert(err.message);
      }
    });

    list.appendChild(item);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

setAuthMode("login");

if (token && user) {
  showApp().catch(() => logout(false));
} else {
  showAuth();
}
