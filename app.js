const app = document.getElementById("app");
const API_BASE = (window.API_BASE || "").replace(/\/$/, "");
const apiUrl = (path) => `${API_BASE}${path}`;

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
  const res = await fetch(apiUrl(url), {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    credentials: "include",
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
  comments: [],
  commentsError: "",
  showCommentForm: false,
  commentDraft: { author: "익명", content: "" },
  page: 1,
  pageSize: 20,
  total: 0,
  view: "list", // list | write | detail
  editMode: false,
  adminLoggedIn: false,
  showAdminLogin: false,
  viewPassword: "",
  selectedIds: new Set(),
};

function setState(next) {
  Object.assign(state, next);
  render();
}

function navigate(view, post = null, replace = false) {
  const postId = typeof post === "string" ? post : post?.id || null;
  const url =
    view === "write"
      ? "/write"
      : view === "detail" && postId
        ? `/post/${postId}`
        : "/";
  const historyState = { view, postId, page: state.page };
  if (replace) history.replaceState(historyState, "", url);
  else history.pushState(historyState, "", url);

  setState({
    view,
    currentPost: typeof post === "object" && post ? post : state.currentPost,
    editMode: false,
    showCommentForm: false,
    commentDraft: { author: "익명", content: "" },
  });
}

function goList(replace = true) {
  refreshPosts().catch(() => alert("게시글을 불러오지 못했습니다."));
  navigate("list", null, replace);
}

function isAdmin() {
  return state.adminLoggedIn;
}

async function refreshAdmin() {
  const data = await apiJson("/api/admin/me");
  setState({ adminLoggedIn: Boolean(data.admin) });
}

async function refreshPosts() {
  const data = await apiJson(`/api/posts?page=${state.page}`);
  setState({
    posts: data.posts || [],
    total: Number.isFinite(data.total) ? data.total : 0,
    pageSize: Number.isFinite(data.pageSize) ? data.pageSize : state.pageSize,
  });
}

async function refreshComments(postId) {
  setState({ commentsError: "" });
  try {
    const data = await apiJson(`/api/posts/${postId}/comments`);
    setState({ comments: data.comments || [], commentsError: "" });
  } catch (err) {
    setState({
      comments: [],
      commentsError: "댓글을 불러오지 못했습니다.",
    });
  }
}

async function openPost(id) {
  const data = await apiJson(`/api/posts/${id}`);
  navigate("detail", data.post);
  setState({
    comments: [],
    showCommentForm: false,
    commentDraft: { author: "익명", content: "" },
  });
  await refreshComments(id);
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
  goList(true);
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

  const password = state.viewPassword || "";
  if (!isAdmin() && !password) {
    alert("먼저 비밀번호를 확인해 주세요.");
    setState({ editMode: false });
    return;
  }

  try {
    await apiJson(`/api/posts/${post.id}`, {
      method: "PUT",
      body: JSON.stringify({
        title,
        content,
        viewToken: post.viewToken || "",
        password,
      }),
    });
  } catch (err) {
    if (/password/i.test(err.message)) {
      alert("비밀번호가 올바르지 않습니다.");
      return;
    }
    throw err;
  }

  await refreshPosts();
  setState({
    currentPost: { ...post, title, content, updatedAt: new Date().toISOString() },
    editMode: false,
  });
}

async function requestEditMode() {
  const post = state.currentPost;
  if (!post) return;
  if (isAdmin()) {
    setState({ editMode: true });
    return;
  }
  const password = prompt("게시글을 수정하려면 비밀번호를 입력하세요.") || "";
  if (!password) return;
  try {
    const data = await apiJson(`/api/posts/${post.id}/view`, {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    setState({
      currentPost: { ...post, viewToken: data.viewToken || "" },
      viewPassword: password,
      editMode: true,
    });
  } catch (err) {
    if (/password/i.test(err.message)) {
      alert("비밀번호가 올바르지 않습니다.");
      return;
    }
    throw err;
  }
}

async function deleteCurrentPost() {
  const post = state.currentPost;
  if (!post) return;

  if (!confirm("이 게시글을 삭제할까요?")) return;

  if (isAdmin()) {
    await apiJson(`/api/posts/${post.id}`, {
      method: "DELETE",
      body: JSON.stringify({}),
    });
  } else {
    const password = prompt("삭제하려면 비밀번호를 입력하세요.") || "";
    if (!password) return;

    try {
      await apiJson(`/api/posts/${post.id}`, {
        method: "DELETE",
        body: JSON.stringify({
          viewToken: post.viewToken || "",
          password,
        }),
      });
    } catch (err) {
      if (/password/i.test(err.message)) {
        alert("비밀번호가 올바르지 않습니다.");
        return;
      }
      throw err;
    }
  }

  await refreshPosts();
  setState({ currentPost: null, editMode: false, viewPassword: "" });
  goList(true);
}

async function createComment(form) {
  const post = state.currentPost;
  if (!post) return;
  const content = form.querySelector("[name=comment-content]").value.trim();
  if (!content) {
    alert("댓글을 입력해 주세요.");
    return;
  }
  try {
    await apiJson(`/api/posts/${post.id}/comments`, {
      method: "POST",
      body: JSON.stringify({ author: "익명", content }),
    });
    form.reset();
    await refreshComments(post.id);
    await refreshPosts();
    setState({
      showCommentForm: false,
      commentDraft: { author: "익명", content: "" },
    });
  } catch {
    alert("댓글 등록에 실패했습니다.");
  }
}

async function deleteComment(commentId) {
  const post = state.currentPost;
  if (!post) return;
  if (!isAdmin()) return;
  if (!confirm("이 댓글을 삭제할까요?")) return;
  await apiJson(`/api/posts/${post.id}/comments/${commentId}`, {
    method: "DELETE",
    body: JSON.stringify({}),
  });
  await refreshComments(post.id);
  await refreshPosts();
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
    } catch {
      alert("로그인에 실패했습니다.");
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
    const commentCount = Number(post.commentCount || 0);
    const commentSuffix =
      Number.isFinite(commentCount) && commentCount > 0
        ? ` [${commentCount}]`
        : "";
    const item = h("div", { class: "list-item" }, [
      isAdmin()
        ? h("input", {
            class: "list-item__check",
            type: "checkbox",
            "data-id": post.id,
          })
        : "",
      h("div", { class: "list-item__row" }, [
        h("div", { class: "list-item__title", text: post.title + commentSuffix }),
        h("div", { class: "list-item__author", text: post.author }),
      ]),
    ]);
    if (isAdmin()) {
      const checkbox = item.querySelector(".list-item__check");
      checkbox.checked = state.selectedIds.has(post.id);
      checkbox.addEventListener("click", (e) => e.stopPropagation());
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.selectedIds.add(post.id);
        else state.selectedIds.delete(post.id);
      });
    }
    item.addEventListener("click", () => {
      openPost(post.id).catch(() => alert("게시글을 불러오지 못했습니다."));
    });
    list.append(item);
  }

  return list;
}

function downloadCsv(filename, rows) {
  const escapeCell = (value) => {
    const text = String(value ?? "");
    if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  };
  const csv = rows.map((row) => row.map(escapeCell).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function exportSelectedPosts() {
  if (!isAdmin()) return;
  const ids = Array.from(state.selectedIds);
  if (ids.length === 0) {
    alert("내보낼 게시물을 선택해 주세요.");
    return;
  }
  const rows = [["제목", "내용", "작성자"]];
  for (const id of ids) {
    const data = await apiJson(`/api/posts/${id}`);
    const post = data.post;
    rows.push([post.title, post.content, post.author]);
  }
  downloadCsv(`woldecks-posts-${new Date().toISOString().slice(0, 10)}.csv`, rows);
}


async function deleteSelectedPosts() {
  if (!isAdmin()) return;
  const ids = Array.from(state.selectedIds);
  if (ids.length === 0) {
    alert("선택된 게시물이 없습니다.");
    return;
  }
  if (!confirm(`선택한 게시물 ${ids.length}개를 삭제할까요?`)) return;

  const results = await Promise.allSettled(
    ids.map((id) =>
      apiJson(`/api/posts/${id}`, {
        method: "DELETE",
        body: JSON.stringify({}),
      }),
    ),
  );
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    alert(`삭제 실패: ${failed.length}건`);
  }

  state.selectedIds = new Set();
  await refreshPosts();
  render();
}





function toggleSelectAll(checked) {
  if (checked) {
    state.selectedIds = new Set(state.posts.map((p) => p.id));
  } else {
    state.selectedIds = new Set();
  }
  render();
}

function renderListView() {
  const allChecked =
    state.posts.length > 0 && state.posts.every((p) => state.selectedIds.has(p.id));
  const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
  const pages = Array.from({ length: totalPages }, (_, i) => i + 1);

  return h("section", { class: "panel" }, [
    h("div", { class: "list-head" }, [
      h("div", { class: "list-head__left" }, [
        h("h2", { class: "panel__title", text: "게시글 목록" }),
        isAdmin()
          ? h("label", { class: "list-head__check" }, [
              h("input", {
                type: "checkbox",
                checked: allChecked ? "checked" : null,
                onChange: (e) => toggleSelectAll(e.target.checked),
              }),
              h("span", { text: "전체 선택" }),
            ])
          : "",
      ]),
      isAdmin()
        ? h("button", {
            class: "btn btn--ghost",
            type: "button",
            text: "CSV 내보내기",
            onClick: () => exportSelectedPosts().catch(() => alert("내보내기에 실패했습니다.")),
          })
        : "",

      isAdmin()
        ? h("button", {
            class: "btn btn--danger",
            type: "button",
            text: "선택 삭제",
            onClick: () => deleteSelectedPosts().catch(() => alert("삭제에 실패했습니다.")),
          })
        : "",
    ]),
    renderList(),
    h("div", { class: "btn-row" }, [
      h("button", {
        class: "btn btn--ghost",
        type: "button",
        text: "이전",
        disabled: state.page <= 1 ? "disabled" : null,
        onClick: () => {
          if (state.page <= 1) return;
          setState({ page: state.page - 1 });
          refreshPosts().catch(() => alert("게시글을 불러오지 못했습니다."));
          navigate("list", null, true);
        },
      }),
      ...pages.map((p) =>
        h("button", {
          class: p === state.page ? "btn" : "btn btn--ghost",
          type: "button",
          text: String(p),
          onClick: () => {
            if (p === state.page) return;
            setState({ page: p });
            refreshPosts().catch(() => alert("게시글을 불러오지 못했습니다."));
            navigate("list", null, true);
          },
        }),
      ),
      h("button", {
        class: "btn btn--ghost",
        type: "button",
        text: "다음",
        disabled: state.page >= totalPages ? "disabled" : null,
        onClick: () => {
          if (state.page >= totalPages) return;
          setState({ page: state.page + 1 });
          refreshPosts().catch(() => alert("게시글을 불러오지 못했습니다."));
          navigate("list", null, true);
        },
      }),
    ]),
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
      h("label", { text: "비밀번호" }),
      h("input", { name: "password", type: "password", placeholder: "비밀번호" }),
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
          onClick: () => goList(true),
        }),
      ]),
    ]);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    createPost(form).catch(() => alert("등록에 실패했습니다."));
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
        h("button", {
          class: "btn btn--ghost",
          type: "button",
          text: "목록",
          onClick: () => goList(true),
        }),
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
      updateCurrentPost(editForm).catch(() => alert("수정에 실패했습니다."));
    });

    return h("section", { class: "panel" }, [
      h("div", { class: "btn-row" }, [
        h("button", {
          class: "btn btn--ghost",
          type: "button",
          text: "목록",
          onClick: () => goList(true),
        }),
      ]),
      editForm,
    ]);
  }


  const commentForm = h("form", {}, [
    h("h3", { class: "panel__title", text: "댓글" }),
    h("div", { class: "field" }, [
      h("label", { text: "댓글" }),
      h(
        "textarea",
        {
          name: "comment-content",
          placeholder: "댓글",
          onInput: (e) => {
            state.commentDraft = {
              ...state.commentDraft,
              author: "익명",
              content: e.target.value,
            };
          },
        },
        [state.commentDraft.content],
      ),
    ]),
    h("div", { class: "btn-row" }, [
      h("button", { class: "btn", type: "submit", text: "등록" }),
      h("button", {
        class: "btn btn--ghost",
        type: "button",
        text: "취소",
        onClick: () => setState({ showCommentForm: false }),
      }),
    ]),
  ]);

  commentForm.addEventListener("submit", (e) => {
    e.preventDefault();
    createComment(commentForm).catch(() => alert("댓글 등록에 실패했습니다."));
  });

  const commentList = state.commentsError
    ? h("p", { class: "panel__text", text: state.commentsError })
    : state.comments.length === 0
      ? h("p", { class: "panel__text", text: "댓글이 없습니다." })
      : h(
          "div",
          { class: "list" },
          state.comments.map((c) =>
            h("div", { class: "list-item" }, [
              h("div", { class: "list-item__row" }, [
                h("div", { class: "list-item__title", text: c.author }),
                h("div", { class: "list-item__author", text: formatDate(c.createdAt) }),
              ]),
              h("div", { class: "detail__content", text: c.content }),
              isAdmin()
                ? h("div", { class: "btn-row" }, [
                    h("button", {
                      class: "btn btn--danger",
                      type: "button",
                      text: "댓글 삭제",
                      onClick: () => deleteComment(c.id).catch(() => alert("삭제에 실패했습니다.")),
                    }),
                  ])
                : "",
            ]),
          ),
        );


  const commentToggle = h("div", { class: "btn-row" }, [
    h("button", {
      class: "btn",
      type: "button",
      text: state.showCommentForm ? "댓글 숨기기" : "댓글 작성",
      onClick: () => setState({ showCommentForm: !state.showCommentForm }),
    }),
  ]);

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
      h("button", {
        class: "btn btn--ghost",
        type: "button",
        text: "목록",
      onClick: () => goList(true),
      }),
      h("button", { class: "btn", type: "button", text: "수정", onClick: () => requestEditMode() }),
      h("button", {
        class: "btn btn--danger",
        type: "button",
        text: "삭제",
        onClick: () => deleteCurrentPost().catch(() => alert("삭제에 실패했습니다.")),
      }),
    ]),
    commentToggle,
    state.showCommentForm ? commentForm : "",
    commentList,
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
          onClick: () =>
            state.view === "write" ? goList(true) : navigate("write"),
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
  } catch {
    alert("요청에 실패했습니다.");
  }
});

Promise.all([refreshAdmin(), refreshPosts()])
  .catch(() => alert("데이터를 불러오지 못했습니다."))
  .finally(() => {
    if (!history.state) navigate("list", null, true);
    render();
  });

window.addEventListener("popstate", async (event) => {
  const st = event.state;
  if (!st || !st.view) {
    setState({ view: "list", currentPost: null, editMode: false });
    return;
  }
  if (st.view === "detail" && st.postId) {
    if (state.currentPost?.id === st.postId) {
      setState({ view: "detail", editMode: false });
      return;
    }
    try {
      const data = await apiJson(`/api/posts/${st.postId}`);
      setState({
        comments: [],
        showCommentForm: false,
        commentDraft: { author: "익명", content: "" },
      });
      await refreshComments(st.postId);
      setState({ view: "detail", currentPost: data.post, editMode: false });
    } catch {
      setState({ view: "list", currentPost: null, editMode: false });
    }
    return;
  }
  if (st.view === "write") {
    setState({ view: "write", currentPost: null, editMode: false });
    return;
  }
  if (st.view === "list") {
    const page = Number.isFinite(st.page) && st.page > 0 ? st.page : 1;
    setState({ view: "list", currentPost: null, editMode: false, page });
    await refreshPosts();
    return;
  }
  setState({ view: "list", currentPost: null, editMode: false });
});
