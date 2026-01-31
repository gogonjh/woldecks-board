const app = document.getElementById("app");

function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== undefined && value !== null) {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of children) el.append(child);
  return el;
}

function formatDate(date) {
  const d = new Date(date);
  return d.toLocaleString("ko-KR", { hour12: false });
}

async function apiJson(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    credentials: "same-origin",
    ...options,
  });

  const isJson = (res.headers.get("content-type") || "").includes("application/json");
  const payload = isJson ? await res.json() : null;

  if (!res.ok) {
    const msg = payload?.error || `요청 실패: ${res.status}`;
    throw new Error(msg);
  }
  return payload;
}

const state = {
  posts: [],
  currentPost: null,
  view: "list", // list | write | detail
  editMode: false,
  adminLoggedIn: false,
  showAdminLogin: false,
  viewPassword: "",
};

function setState(next) {
  Object.assign(state, next);
  render();
}

function isAdmin() {
  return state.adminLoggedIn;
}

async function refreshAdmin() {
  const data = await apiJson("/api/admin/me");
  setState({ adminLoggedIn: Boolean(data.admin) });
}

async function refreshPosts() {
  const data = await apiJson("/api/posts");
  setState({ posts: data.posts || [] });
}

async function openPost(id) {
  if (isAdmin()) {
    const data = await apiJson(`/api/posts/${id}`);
    setState({ currentPost: data.post, view: "detail", editMode: false });
    return;
  }
  const password = prompt("게시글 비밀번호를 입력하세요.");
  if (password === null) return;
  const data = await apiJson(`/api/posts/${id}/view`, {
    method: "POST",
    body: JSON.stringify({ password }),
  });
  setState({
    currentPost: { ...data.post, viewToken: data.viewToken },
    view: "detail",
    editMode: false,
    viewPassword: password,
  });
}

async function createPost(form) {
  const title = form.querySelector("[name=title]").value.trim();
  const author = form.querySelector("[name=author]").value.trim();
  const password = form.querySelector("[name=password]").value;
  const content = form.querySelector("[name=content]").value.trim();

  form.querySelector(".toast")?.remove();
  if (!title || !author || !password || !content) {
    form.append(h("div", { class: "toast", text: "모든 항목을 입력해 주세요." }));
    return;
  }

  await apiJson("/api/posts", {
    method: "POST",
    body: JSON.stringify({ title, author, password, content }),
  });

  await refreshPosts();
  form.reset();
  setState({ view: "list" });
}

async function updateCurrentPost(form) {
  const post = state.currentPost;
  if (!post) return;

  const title = form.querySelector("[name=edit-title]").value.trim();
  const content = form.querySelector("[name=edit-content]").value.trim();
  if (!title || !content) {
    alert("제목과 내용을 입력해 주세요.");
    return;
  }
  try {
    await apiJson(`/api/posts/${post.id}`, {
      method: "PUT",
      body: JSON.stringify({
        title,
        content,
        viewToken: post.viewToken || "",
        password: state.viewPassword || "",
      }),
    });
  } catch (err) {
    if (!isAdmin() && /password/i.test(err.message)) {
      setState({ view: "list", editMode: false, currentPost: null });
      return;
    }
    throw err;
  }

  await refreshPosts();
  setState({
    currentPost: { ...post, title, content, updatedAt: new Date().toISOString() },
    editMode: false,
    view: "detail",
  });
}

async function deleteCurrentPost() {
  const post = state.currentPost;
  if (!post) return;

  if (!confirm("정말 삭제할까요?")) return;

  try {
    await apiJson(`/api/posts/${post.id}`, {
      method: "DELETE",
      body: JSON.stringify({
        viewToken: post.viewToken || "",
        password: state.viewPassword || "",
      }),
    });
  } catch (err) {
    if (!isAdmin() && /password/i.test(err.message)) {
      setState({ view: "list", editMode: false, currentPost: null });
      return;
    }
    throw err;
  }

  await refreshPosts();
  setState({ currentPost: null, view: "list", editMode: false, viewPassword: "" });
}

function renderAdminModal() {
  if (!state.showAdminLogin) return "";

  const form = h("form", {}, [
    h("div", { class: "modal__header" }, [
      h("h2", { class: "modal__title", text: "관리자 로그인" }),
      h("button", {
        class: "modal__close",
        type: "button",
        text: "×",
        onClick: () => setState({ showAdminLogin: false }),
      }),
    ]),
    h("p", {
      class: "panel__text",
      text: "관리자 비밀번호를 입력하면 모든 게시물을 관리할 수 있습니다.",
    }),
    h("div", { class: "field" }, [
      h("label", { text: "관리자 비밀번호" }),
      h("input", { type: "password", name: "adminPassword", placeholder: "관리자 비밀번호" }),
    ]),
    h("div", { class: "btn-row" }, [
      h("button", { class: "btn", type: "submit", text: "로그인" }),
    ]),
  ]);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = form.querySelector("[name=adminPassword]").value;
    try {
      await apiJson("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ password: input }),
      });
      await refreshAdmin();
      setState({ showAdminLogin: false });
    } catch (err) {
      alert(err.message);
    }
  });

  const backdrop = h("div", { class: "backdrop" }, [h("div", { class: "modal" }, [form])]);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) setState({ showAdminLogin: false });
  });
  return backdrop;
}

function renderList() {
  const list = h("div", { class: "list" });
  if (state.posts.length === 0) {
    list.append(h("p", { class: "empty", text: "아직 등록된 게시물이 없습니다." }));
    return list;
  }

  for (const post of state.posts) {
    const item = h("div", { class: "list-item" }, [
      h("div", { class: "list-item__row" }, [
        h("div", { class: "list-item__title", text: post.title }),
        h("div", { class: "list-item__author", text: post.author }),
      ]),
    ]);
    item.addEventListener("click", () => {
      openPost(post.id).catch((err) => alert(err.message));
    });
    list.append(item);
  }

  return list;
}

function renderListView() {
  return h("section", { class: "panel" }, [
    h("h2", { class: "panel__title", text: "게시글 목록" }),
    renderList(),
  ]);
}

function renderWriteView() {
  const form = h("form", {}, [
    h("h1", { class: "title", text: "불만 접수 작성" }),
    h("p", {
      class: "subtitle",
      text: "비밀번호는 수정 및 삭제에 사용됩니다.",
    }),
    h("div", { class: "field" }, [
      h("label", { text: "제목" }),
      h("input", { name: "title", placeholder: "제목" }),
    ]),
    h("div", { class: "field" }, [
      h("label", { text: "작성자" }),
      h("input", { name: "author", placeholder: "이름" }),
    ]),
    h("div", { class: "field" }, [
      h("label", { text: "게시글 비밀번호(그대로 표시됨)" }),
      h("input", { name: "password", type: "text", placeholder: "비밀번호" }),
    ]),
    h("div", { class: "field" }, [
      h("label", { text: "내용" }),
      h("textarea", { name: "content", placeholder: "내용" }),
    ]),
    h("div", { class: "btn-row" }, [
      h("button", { class: "btn", type: "submit", text: "등록" }),
      h("button", {
        class: "btn btn--ghost",
        type: "button",
        text: "취소",
        onClick: () => setState({ view: "list" }),
      }),
    ]),
  ]);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    createPost(form).catch((err) => alert(err.message));
  });

  return h("section", { class: "panel" }, [form]);
}

function renderDetailView() {
  const post = state.currentPost;
  if (!post) {
    return h("section", { class: "panel" }, [
      h("h2", { class: "panel__title", text: "게시글 상세" }),
      h("p", { class: "panel__text", text: "게시글을 선택해 주세요." }),
      h("div", { class: "btn-row" }, [
        h("button", { class: "btn btn--ghost", type: "button", text: "목록", onClick: () => setState({ view: "list" }) }),
      ]),
    ]);
  }

  if (state.editMode) {
    const editForm = h("form", {}, [
      h("h1", { class: "title", text: "게시글 수정" }),
      h("div", { class: "field" }, [
        h("label", { text: "제목" }),
        h("input", { name: "edit-title", value: post.title }),
      ]),
      h("div", { class: "field" }, [
        h("label", { text: "내용" }),
        h("textarea", { name: "edit-content" }, [post.content]),
      ]),
      h("div", { class: "btn-row" }, [
        h("button", { class: "btn", type: "submit", text: "저장" }),
        h("button", {
          class: "btn btn--ghost",
          type: "button",
          text: "취소",
          onClick: () => setState({ editMode: false }),
        }),
      ]),
    ]);

    editForm.addEventListener("submit", (e) => {
      e.preventDefault();
      updateCurrentPost(editForm).catch((err) => alert(err.message));
    });

    return h("section", { class: "panel" }, [
      h("div", { class: "btn-row" }, [
        h("button", { class: "btn btn--ghost", type: "button", text: "목록", onClick: () => setState({ view: "list", editMode: false }) }),
      ]),
      editForm,
    ]);
  }

  return h("section", { class: "panel" }, [
    h("h1", { class: "title", text: post.title }),
    h("p", {
      class: "panel__text",
      text: `작성자: ${post.author} / 작성일: ${formatDate(post.createdAt)}`,
    }),
    post.updatedAt
      ? h("p", { class: "panel__text", text: `수정일: ${formatDate(post.updatedAt)}` })
      : "",
    h("div", { class: "detail__content", text: post.content }),
    h("div", { class: "btn-row" }, [
      h("button", { class: "btn btn--ghost", type: "button", text: "목록", onClick: () => setState({ view: "list" }) }),
      h("button", { class: "btn", type: "button", text: "수정", onClick: () => setState({ editMode: true }) }),
      h("button", {
        class: "btn btn--danger",
        type: "button",
        text: "삭제",
        onClick: () => deleteCurrentPost().catch((err) => alert(err.message)),
      }),
    ]),
  ]);
}

function render() {
  const content =
    state.view === "write"
      ? renderWriteView()
      : state.view === "detail"
        ? renderDetailView()
        : renderListView();

  const fab =
    state.view === "detail"
      ? ""
      : h("button", {
          class: "btn fab",
          type: "button",
          text: state.view === "write" ? "목록으로" : "글쓰기",
          onClick: () => setState({ view: state.view === "write" ? "list" : "write" }),
        });

  app.replaceChildren(h("div", { class: "stack" }, [content, fab, renderAdminModal()]));
}

document.getElementById("year").textContent = String(new Date().getFullYear());
document.getElementById("adminButton").addEventListener("click", async () => {
  try {
    await refreshAdmin();
    if (state.adminLoggedIn) {
      if (!confirm("관리자 로그아웃 하시겠어요?")) return;
      await apiJson("/api/admin/logout", { method: "POST" });
      await refreshAdmin();
      return;
    }
    setState({ showAdminLogin: true });
  } catch (err) {
    alert(err.message);
  }
});

Promise.all([refreshAdmin(), refreshPosts()])
  .catch((err) => alert(err.message))
  .finally(() => render());
