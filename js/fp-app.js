/* =========================================================
   fp-app.js — NORTHLINE multi-step form.
   Talks to Supabase via js/fp-client.js. No build step.
   ========================================================= */

(function(){
  var STEPS = ["profile", "pathway", "institutes", "faculties", "additional", "review"];
  var STEP_LABELS = {
    profile: "Student information",
    pathway: "Pathway",
    institutes: "Institute preferences",
    faculties: "Faculty preferences",
    additional: "Additional information",
    review: "Review & submit"
  };

  var state = {
    session: null,
    studentId: null,
    stepIndex: 0,
    profile: { student_name:"", father_name:"", father_profession:"", contact:"", discipline:"", section:"", roll_number:"", matric_marks:"", first_year_marks:"" },
    pathway: null,               // 'engineering' | 'medical'
    careerIds: [],                // retained for backward-compat load; no longer used in UI
    customCareer: "",
    institutes: [],               // master data, filtered by pathway
    faculties: [],
    instituteGroups: [],          // [[id|null x5], ...]
    instituteCustom: [],          // [[text x5], ...] used when an "Other" institute is picked
    facultyGroups: [],
    facultyCustom: [],
    additionalInfo: "",
    futurePathwayId: null,
    status: null,                 // 'draft' | 'submitted' | null (no row yet)
    saving: false,
    actingAsStaff: false          // true when a counsellor/admin is editing someone else's form
  };

  function groupCount(){ return state.pathway === "medical" ? 2 : 4; }

  function emptyGroups(n){
    var g = [];
    for(var i=0;i<n;i++){ g.push([null,null,null,null,null]); }
    return g;
  }
  function emptyCustom(n){
    var g = [];
    for(var i=0;i<n;i++){ g.push(["","","","",""]); }
    return g;
  }

  // ---------------------------------------------------------
  // Boot: auth check, load profile + existing draft/submission
  //
  // Two paths:
  //
  // - Normal (no ?student= param): a student filling their own
  //   form. Deliberately NOT using FP.requireAuth() -- that also
  //   fetches the app_users role via a second round-trip, which
  //   this path never needs (no role-gated behavior when you're
  //   just filling your own form). client.auth.getSession()
  //   resolves from local storage in the common case (no network
  //   round-trip), so this page's own data queries can start
  //   immediately instead of waiting on a role lookup this path
  //   doesn't use.
  //
  // - Counsellor/admin editing someone else's form
  //   (?student=<id>): DOES need the role fetch, to verify the
  //   logged-in user is actually staff before treating the URL
  //   param as authoritative. RLS enforces this server-side
  //   regardless (see supabase/counsellor_managed_students.sql --
  //   a non-staff user hitting this URL would have every query
  //   rejected), this client-side check is just so a non-staff
  //   user gets a clear message instead of a page full of failed
  //   requests.
  //
  // Either way: loadMasterData()/loadMeritFormulas()/loadClosingMerit()
  // don't need studentId or role (public master data, RLS-gated
  // server-side regardless) -- those three fire immediately,
  // before the session is even known.
  // ---------------------------------------------------------
  var editingStudentId = new URLSearchParams(window.location.search).get("student");
  var masterDataPromise = loadMasterData();
  var meritPromise = (typeof FP !== "undefined" && FP.loadMeritFormulas) ? FP.loadMeritFormulas() : Promise.resolve();
  var closingMeritPromise = (typeof FP !== "undefined" && FP.loadClosingMerit) ? FP.loadClosingMerit() : Promise.resolve();

  var authPromise = editingStudentId
    ? FP.getSessionAndProfile()
    : FP.client.auth.getSession().then(function(r){ return r.data.session ? { session: r.data.session, profile: null } : null; });

  authPromise.then(function(result){
    if(!result || !result.session){ window.location.href = "login.html"; return; }
    state.session = result.session;

    if(editingStudentId){
      var role = result.profile ? result.profile.role : "student";
      if(role !== "counsellor" && role !== "admin"){
        window.location.href = "access-denied.html";
        return;
      }
      state.studentId = editingStudentId;
      state.actingAsStaff = true;
    } else {
      state.studentId = result.session.user.id;
    }

    return Promise.all([
      loadProfile(),
      loadFuturePathway(),
      masterDataPromise
    ]).then(function(){
      render();
      initUniModal();
      meritPromise.catch(function(err){ console.error("Merit formulas failed to load:", err); });
      closingMeritPromise.catch(function(err){ console.error("Closing merit records failed to load:", err); });
    });
  }).catch(function(err){
    console.error(err);
  });

  document.getElementById("fp-logout").addEventListener("click", function(){
    FP.signOut();
  });

  // "+ Add new student" -- lives here on the form page itself, not
  // as a redirect-through from admin.html (that was an unnecessary
  // extra hop: click in admin -> create -> land back here anyway).
  // Staff-only, enforced by counsellor_create_student() itself
  // (raises an exception for anyone else) -- not gated client-side
  // here, since a real walk-in student never has their own login to
  // reach this page unprompted in the first place (confirmed
  // workflow: student never logs in, counsellor manages everything).
  var addStudentBtn = document.getElementById("fp-add-student");
  if(addStudentBtn){
    addStudentBtn.addEventListener("click", function(){
      addStudentBtn.disabled = true;
      addStudentBtn.textContent = "Creating\u2026";
      FP.client.rpc("counsellor_create_student").then(function(r){
        if(r.error){
          if(FP.toast) FP.toast.error("Could not create student: " + r.error.message);
          else alert("Could not create student: " + r.error.message);
          addStudentBtn.disabled = false;
          addStudentBtn.textContent = "+ Add new student";
          return;
        }
        if(FP.toast) FP.toast.success("Student created");
        window.location.href = "pathways.html?student=" + encodeURIComponent(r.data);
      });
    });
  }

  // ---------------------------------------------------------
  // "View all universities" modal — groups state.allInstitutes
  // (all active institutes, both pathways, already loaded via
  // loadMasterData) into Engineering / Medical / Other buckets
  // by their `pathway` column. "Other" only appears if any
  // institute has a pathway value outside engineering/medical.
  // ---------------------------------------------------------
  function initUniModal(){
    var openBtn      = document.getElementById("viewUnisBtn");
    var overlay      = document.getElementById("uniModalOverlay");
    var closeBtn      = document.getElementById("uniModalClose");
    var body          = document.getElementById("uniModalBody");
    var searchInput  = document.getElementById("uniModalSearch");
    var searchBtn    = document.getElementById("uniModalSearchBtn");
    if(!openBtn || !overlay || !closeBtn || !body) return;

    function open(){
      body.innerHTML = renderUniGroups(searchInput ? searchInput.value : "");
      overlay.hidden = false;
      void overlay.offsetWidth; // force reflow so the opacity/transform transition actually plays
      overlay.classList.add("is-open");
      document.addEventListener("keydown", onKeydown);
    }
    function close(){
      overlay.classList.remove("is-open");
      document.removeEventListener("keydown", onKeydown);
      setTimeout(function(){
        if(!overlay.classList.contains("is-open")) overlay.hidden = true;
      }, 320);
    }
    function onKeydown(e){ if(e.key === "Escape") close(); }
    function reRender(){ body.innerHTML = renderUniGroups(searchInput.value); }

    openBtn.addEventListener("click", open);
    closeBtn.addEventListener("click", close);
    overlay.addEventListener("click", function(e){
      if(e.target === overlay) close();
    });

    if(searchInput){
      searchInput.addEventListener("input", reRender);
      searchInput.addEventListener("keydown", function(e){
        if(e.key === "Enter"){ e.preventDefault(); reRender(); }
      });
    }
    if(searchBtn) searchBtn.addEventListener("click", reRender);

    body.addEventListener("click", function(e){
      if(e.target.classList.contains("merit-toggle")){
        var instName = e.target.dataset.inst;
        var container = e.target.closest("li").querySelector(".merit-inline-container");
        var isOpen = !container.hidden;
        if(isOpen){
          container.hidden = true;
          e.target.textContent = "View merit formula";
          return;
        }
        container.innerHTML = FP.renderMeritSectionForInstitute(instName);
        container.hidden = false;
        e.target.textContent = "Hide merit formula";
        return;
      }

      if(e.target.classList.contains("program-search-btn")){
        var section = e.target.closest(".programs-inline-section");
        if(section) FP.filterProgramsSection(section);
      }
    });

    body.addEventListener("input", function(e){
      if(!e.target.classList.contains("program-search-input")) return;
      var section = e.target.closest(".programs-inline-section");
      if(section) FP.filterProgramsSection(section);
    });

    body.addEventListener("keydown", function(e){
      if(e.key !== "Enter" || !e.target.classList.contains("program-search-input")) return;
      e.preventDefault();
      var section = e.target.closest(".programs-inline-section");
      if(section) FP.filterProgramsSection(section);
    });
  }

  function renderUniGroups(searchTerm){
    var all = state.allInstitutes || [];

    var q = (searchTerm || "").trim().toLowerCase();
    if(q){
      all = all.filter(function(inst){
        return String(inst.name || "").toLowerCase().indexOf(q) !== -1;
      });
      if(all.length === 0){
        return '<p class="uni-modal-empty">No universities match \u201c' + escapeHtml(searchTerm.trim()) + '\u201d.</p>';
      }
    }

    var buckets = { "Engineering": [], "Medical": [], "Other": [] };

    all.forEach(function(inst){
      var bucket = inst.pathway === "engineering" ? "Engineering"
                 : inst.pathway === "medical"      ? "Medical"
                 : "Other";
      buckets[bucket].push(inst);
    });

    var order = ["Engineering", "Medical", "Other"];
    return order
      .filter(function(name){ return buckets[name].length > 0; })
      .map(function(name){
        var entries = buckets[name];
        var listHtml = "<ul>" + entries.map(function(inst){
              var meta = inst.location || (inst.campuses && inst.campuses.length ? inst.campuses.join(", ") : "");
              return "<li><div class=\"uni-modal-row\"><span>" + escapeHtml(inst.name) + "</span>" +
                     "<span class=\"uni-modal-programs\">" + escapeHtml(meta) + "</span>" +
                     "<div class=\"uni-modal-actions\">" +
                       "<button type=\"button\" class=\"merit-toggle\" data-inst=\"" + escapeHtml(inst.name) + "\">View merit formula</button>" +
                     "</div></div>" +
                     "<div class=\"merit-inline-container\" hidden></div></li>";
            }).join("") + "</ul>";

        return "<div class=\"uni-modal-group\"><h3>" + name + " (" + entries.length + ")</h3>" + listHtml + "</div>";
      }).join("");
  }

  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, function(c){
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
    });
  }

  function loadProfile(){
    return FP.client.from("students").select("*").eq("id", state.studentId).maybeSingle()
      .then(function(r){
        if(r.error){ console.error(r.error); return; }
        if(r.data){
          Object.keys(state.profile).forEach(function(k){
            if(r.data[k] !== null && r.data[k] !== undefined) state.profile[k] = r.data[k];
          });
        }
      });
  }

  function loadFuturePathway(){
    return FP.client.from("future_pathways").select("*")
      .eq("student_id", state.studentId)
      .order("created_at", { ascending:false })
      .limit(1).maybeSingle()
      .then(function(r){
        if(r.error){ console.error(r.error); return; }
        if(!r.data) return;
        state.futurePathwayId = r.data.id;
        state.status = r.data.status;
        state.submittedAt = r.data.submitted_at ? new Date(r.data.submitted_at) : null;
        state.pathway = r.data.pathway;
        state.additionalInfo = r.data.additional_information || "";
        state.instituteGroups = emptyGroups(groupCount());
        state.instituteCustom = emptyCustom(groupCount());
        state.facultyGroups = emptyGroups(groupCount());
        state.facultyCustom = emptyCustom(groupCount());
        return loadPreferences();
      });
  }

  function loadPreferences(){
    return Promise.all([
      FP.client.from("student_institute_preferences").select("*").eq("future_pathway_id", state.futurePathwayId),
      FP.client.from("student_faculty_preferences").select("*").eq("future_pathway_id", state.futurePathwayId),
      FP.client.from("student_program_preferences").select("*").eq("future_pathway_id", state.futurePathwayId)
    ]).then(function(results){
      var inst = results[0].data || [];
      var fac = results[1].data || [];
      var prog = results[2].data || [];
      inst.forEach(function(row){
        var gi = row.preference_group - 1, ri = row.rank - 1;
        if(state.instituteGroups[gi]){
          state.instituteGroups[gi][ri] = row.institute_id;
          state.instituteCustom[gi][ri] = row.custom_institute_name || "";
        }
      });
      fac.forEach(function(row){
        var gi = row.preference_group - 1, ri = row.rank - 1;
        if(state.facultyGroups[gi]){
          state.facultyGroups[gi][ri] = row.faculty_id;
          state.facultyCustom[gi][ri] = row.custom_faculty_name || "";
        }
      });
      state.careerIds = prog.filter(function(p){ return p.program_id; }).map(function(p){ return p.program_id; });
      var custom = prog.find(function(p){ return p.custom_program_name; });
      state.customCareer = custom ? custom.custom_program_name : "";
    });
  }

  function loadMasterData(){
    return Promise.all([
      FP.client.from("institutes").select("*").eq("active", true).order("display_order"),
      FP.client.from("fp_faculties").select("*").eq("active", true).order("display_order"),
      FP.client.from("career_options").select("*").eq("active", true).order("display_order")
    ]).then(function(results){
      state.allInstitutes = results[0].data || [];
      state.allFaculties = results[1].data || [];
      state.allCareers = results[2].data || [];
      // Merge career options into the FACULTY list -- these are
      // program/field choices (CA/ACCA, CSS/PMS, BBA, Forces,
      // Computer Sciences, Architecture etc.) and belong alongside
      // faculties, not university names. pathway=null so they
      // appear regardless of engineering/medical selection.
      // "career_" prefix avoids collisions with real faculty UUIDs.
      // Deduplicate by name (case-insensitive) so entries like
      // "Architecture" that appear in both fp_faculties and
      // career_options don't show twice.
      // normKey strips trailing plural 's' so "Computer Science" and
      // "Computer Sciences" collapse to the same dedup key.
      function normKey(name){
        return name.toLowerCase().replace(/\s+/g," ").trim().replace(/s$/, "");
      }
      var existingFacultyNames = {};
      state.allFaculties.forEach(function(f){
        existingFacultyNames[normKey(f.name)] = true;
      });
      state.allCareers.forEach(function(c){
        if(!existingFacultyNames[normKey(c.name)]){
          state.allFaculties.push({
            id: "career_" + c.id,
            name: c.name,
            category: c.category || "other",
            pathway: null,
            active: true,
            display_order: 9000 + (c.display_order || 0)
          });
          existingFacultyNames[normKey(c.name)] = true;
        }
      });
      function byName(a, b){ return a.name.localeCompare(b.name); }
      state.allInstitutes.sort(byName);
      var seenFac = {};
      state.allFaculties = state.allFaculties.filter(function(f){
        var key = normKey(f.name);
        if(seenFac[key]) return false;
        seenFac[key] = true;
        return true;
      });
      state.allFaculties.sort(byName);
    });
  }

  // ---------------------------------------------------------
  // Render
  // ---------------------------------------------------------
  // ---------------------------------------------------------
  // Focus preservation across re-renders
  // render() rebuilds the whole step with innerHTML, which destroys the
  // element the admin was typing in. The browser then drops focus back to
  // the top of the page, so the next Tab press lands on the first button
  // instead of the next field. These helpers remember which field had
  // focus and put it back, so Tab continues in normal sequence.
  // ---------------------------------------------------------
  function captureFocus(container){
    var el = document.activeElement;
    if(!el || el === document.body || !container.contains(el)) return null;
    var info = { id: el.id || null, kind: el.dataset ? el.dataset.kind : null,
                 group: el.dataset ? el.dataset.group : null, rank: el.dataset ? el.dataset.rank : null,
                 tag: el.tagName, type: el.type || null, field: el.dataset ? el.dataset.field : null,
                 name: el.getAttribute("name") };
    try { info.start = el.selectionStart; info.end = el.selectionEnd; } catch(e){}
    return info;
  }

  function restoreFocus(container, info){
    if(!info) return;
    var target = null;
    if(info.id) target = document.getElementById(info.id);
    if(!target && info.kind != null && info.group != null && info.rank != null){
      target = container.querySelector(info.tag.toLowerCase() + '[data-kind="' + info.kind + '"][data-group="' + info.group + '"][data-rank="' + info.rank + '"]');
    }
    if(!target && info.name){
      target = container.querySelector('[name="' + info.name + '"]');
    }
    if(!target || !container.contains(target)) return;
    target.focus({ preventScroll: true });
    try { if(info.start != null) target.setSelectionRange(info.start, info.end); } catch(e){}
  }

  function render(){
    renderProgress();
    renderStatusBanner();
    var step = STEPS[state.stepIndex];
    var container = document.getElementById("fp-step-container");
    var focusInfo = captureFocus(container);
    container.innerHTML = RENDERERS[step]();
    bindStepEvents(step);
    restoreFocus(container, focusInfo);

    document.getElementById("fp-back").style.visibility = state.stepIndex === 0 ? "hidden" : "visible";
    var nextBtn = document.getElementById("fp-next");
    var reviewLabel = state.status === "submitted"
      ? (state.actingAsStaff ? "Update submission" : "Already submitted")
      : "Transmit application";
    nextBtn.textContent = step === "review" ? reviewLabel : "Save & Continue";
    nextBtn.disabled = state.status === "submitted" && !state.actingAsStaff;
    nextBtn.classList.toggle("btn-transmit", step === "review");
    nextBtn.classList.toggle("btn-primary", step !== "review");
  }

  var MANIFEST_LABELS = {
    profile: "STUDENT", pathway: "PATHWAY",
    institutes: "INSTITUTES", faculties: "FACULTIES", additional: "NOTES", review: "REVIEW"
  };

  // Real state, not step position — a line ticks the moment the
  // data exists, whether or not the student has reached that step yet.
  function manifestValue(stepKey){
    if(stepKey === "profile"){
      var p = state.profile;
      var required = ["student_name","father_name","contact","discipline","roll_number","matric_marks","first_year_marks"];
      var filled = required.filter(function(k){ return p[k] || p[k] === 0; }).length;
      if(filled === 0) return null;
      return filled === required.length ? "COMPLETE" : (filled + "/" + required.length + " FILLED");
    }
    if(stepKey === "pathway"){
      return state.pathway ? state.pathway.toUpperCase() : null;
    }
    if(stepKey === "institutes" || stepKey === "faculties"){
      var groups = stepKey === "institutes" ? state.instituteGroups : state.facultyGroups;
      if(!groups || !groups.length) return null;
      var filled2 = 0, total = 0;
      groups.forEach(function(g){ g.forEach(function(v){ total++; if(v) filled2++; }); });
      return filled2 > 0 ? (filled2 + "/" + total + " RANKED") : null;
    }
    if(stepKey === "additional"){
      return state.additionalInfo && state.additionalInfo.trim() ? "ADDED" : null;
    }
    if(stepKey === "review"){
      return state.status === "submitted" ? "SUBMITTED" : null;
    }
    return null;
  }

  function renderProgress(){
    var wrap = document.getElementById("fp-progress");
    wrap.innerHTML = STEPS.map(function(s, i){
      var value = manifestValue(s);
      var isCurrent = i === state.stepIndex;
      var cls = value ? "is-done" : (isCurrent ? "is-current" : "");
      var glyph = value ? "\u2713" : (isCurrent ? "\u25B8" : "\u2013");
      return '<button type="button" class="fp-manifest-line ' + cls + '" data-step-index="' + i + '">' +
        '<span class="fp-m-glyph">' + glyph + '</span>' +
        '<span class="fp-m-label">' + MANIFEST_LABELS[s] + '</span>' +
        '<span class="fp-m-value">' + esc(value || "") + '</span>' +
      '</button>';
    }).join("");

    // Wire jump-to clicks — developer/tester shortcut, no save on jump
    wrap.querySelectorAll(".fp-manifest-line").forEach(function(btn){
      btn.addEventListener("click", function(){
        var target = parseInt(btn.dataset.stepIndex, 10);
        if(target !== state.stepIndex){
          state.stepIndex = target;
          render();
        }
      });
    });

    document.getElementById("fp-progress-label").innerHTML =
      "<span>STEP " + String(state.stepIndex+1).padStart(2,"0") + " / " + String(STEPS.length).padStart(2,"0") + "</span>" +
      "<span>" + esc(STEP_LABELS[STEPS[state.stepIndex]].toUpperCase()) + "</span>";
    document.body.classList.toggle("is-review-step", STEPS[state.stepIndex] === "review");
  }

  function renderStatusBanner(){
    var el = document.getElementById("fp-status-banner");

    if(state.actingAsStaff){
      var name = state.profile.student_name || "this student";
      var statusNote = state.status === "submitted"
        ? "Already submitted — changes here update the existing submission."
        : state.status === "draft"
          ? "Draft in progress."
          : "New record — nothing saved yet.";
      el.innerHTML = '<div class="fp-status-banner staff-editing">' +
        '<strong>Editing on behalf of ' + esc(name) + '.</strong> ' + esc(statusNote) +
        '</div>';
      return;
    }

    if(state.status === "submitted"){
      el.innerHTML = '<div class="fp-status-banner submitted">This NORTHLINE form has been submitted. It is locked for editing — contact the admin office for changes.</div>';
    } else if(state.status === "draft"){
      el.innerHTML = '<div class="fp-status-banner draft">A draft is saved. Progress is saved automatically as you move through the steps.</div>';
    } else {
      el.innerHTML = "";
    }
  }

  function esc(s){
    return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
  }

  // Some legacy-imported student records have names in ALL CAPS
  function titleCase(s){
    return String(s || "").toLowerCase().replace(/\b\w/g, function(c){ return c.toUpperCase(); });
  }

  var RENDERERS = {
    profile: function(){
      var p = state.profile;
      return '<h2 class="fp-step-title">Student information</h2>' +
        '<p class="fp-step-desc">We\'ve filled in what we already know — check it over.</p>' +
        '<div class="fp-form">' +
          '<div class="fp-grid-2">' +
            '<label>Full name' +
              '<input type="text" data-field="student_name" id="fp-student-name-input" value="' + esc(p.student_name) + '" required>' +
              '<span class="fp-field-hint" id="fp-duplicate-name-hint"></span>' +
            '</label>' +
            field("father_name", "Father\'s name", p.father_name) +
          '</div>' +
          '<div class="fp-grid-2">' +
            field("father_profession", "Father\'s profession", p.father_profession) +
            '<label>Contact number' +
              '<input type="tel" data-field="contact" id="fp-contact-input"' +
              ' value="' + esc(p.contact) + '"' +
              ' maxlength="11" inputmode="numeric"' +
              ' placeholder="03XXXXXXXXX" autocomplete="tel" required>' +
              '<span class="fp-field-hint" id="fp-contact-hint"></span>' +
            '</label>' +
          '</div>' +
          '<div class="fp-grid-2">' +
            '<label>Discipline' +
              '<select data-field="discipline" required>' +
              '<option value="">select</option>' +
              ["Pre-Engineering","Pre-Medical","ICS","Commerce","Arts / Humanities",
               "Forces (PAF/Army/Navy)","Other"].map(function(d){
                return '<option value="' + esc(d) + '"'+(p.discipline===d?' selected':'')+'>'+esc(d)+'</option>';
              }).join("") +
            '</select></label>' +
            field("section", "Section", p.section) +
          '</div>' +
          '<div class="fp-grid-2">' +
            field("roll_number", "Roll number", p.roll_number) +
            field("matric_marks", "Matric marks", p.matric_marks, "number") +
          '</div>' +
          field("first_year_marks", "FSc Part 1 marks", p.first_year_marks, "number") +
        '</div>';

      function field(key, label, val, type){
        return '<label>' + label +
          '<input type="' + (type||"text") + '" data-field="' + key + '" value="' + esc(val) + '" required>' +
          '</label>';
      }
    },

    pathway: function(){
      return '<h2 class="fp-step-title">Choose the pathway</h2>' +
        '<p class="fp-step-desc">This determines which institutes, faculties, and programs appear next.</p>' +
        '<div class="fp-pathway-options">' +
          pathwayCard("engineering", "Engineering / Non-Medical", "Engineering, Computer & IT, and related programs.") +
          pathwayCard("medical", "Medical / Health Sciences", "MBBS, BDS, Pharm D, DPT, and related programs.") +
        '</div>';

      function pathwayCard(val, title, desc){
        var sel = state.pathway === val ? "is-selected" : "";
        return '<button type="button" class="fp-pathway-card ' + sel + '" data-pathway="' + val + '">' +
          '<h3>' + title + '</h3><p>' + desc + '</p></button>';
      }
    },

    careers: function(){ return ""; }, // removed -- career options now live in the institute list

    institutes: function(){
      if(!state.pathway) return '<p class="fp-step-desc">Pick a pathway first.</p>';
      // Include both pathway-specific institutes AND career options
      // (which have pathway: null after the merge in loadMasterData)
      var options = state.allInstitutes.filter(function(i){
        return i.pathway === state.pathway;
      });
      ensureGroupArrays();
      return '<h2 class="fp-step-title">Institute preferences</h2>' +
        '<p class="fp-step-desc">Rank up to 5 institutes in each group, 1 = highest preference. No repeats within a group.</p>' +
        prefGroupsHTML("institute", options, state.instituteGroups, state.instituteCustom);
    },

    faculties: function(){
      if(!state.pathway) return '<p class="fp-step-desc">Pick a pathway first.</p>';
      var options = state.allFaculties.filter(function(f){ return f.pathway === state.pathway || f.pathway === null; });
      ensureGroupArrays();
      return '<h2 class="fp-step-title">Faculty preferences</h2>' +
        '<p class="fp-step-desc">Rank up to 5 faculties/programs in each group, 1 = highest preference. No repeats within a group.</p>' +
        prefGroupsHTML("faculty", options, state.facultyGroups, state.facultyCustom);
    },

    additional: function(){
      return '<h2 class="fp-step-title">Additional information</h2>' +
        '<p class="fp-step-desc">Anything else the admissions office should know.</p>' +
        '<textarea id="fp-additional" rows="6" style="width:100%; font-family:var(--font-body); padding:10px 12px; border:1px solid var(--line-strong); border-radius:var(--radius-sm);">' + esc(state.additionalInfo) + '</textarea>';
    },

    review: function(){
      var p = state.profile;

      var instHtml = groupsReviewHtml(state.instituteGroups, state.instituteCustom, state.allInstitutes.filter(function(i){ return i.pathway===state.pathway; }));
      var facHtml = groupsReviewHtml(state.facultyGroups, state.facultyCustom, state.allFaculties.filter(function(f){ return f.pathway===state.pathway || f.pathway===null; }));

      var stampHtml = "";
      if(state.status === "submitted"){
        var stampDate = state.submittedAt || new Date();
        stampHtml = '<div class="fp-transmit-stamp" style="margin-bottom:20px;">' +
          '&#10003; TRANSMITTED | ' + esc(stampDate.toISOString().replace("T"," ").slice(0,19)) + ' UTC</div>';
      }

      return '<h2 class="fp-step-title">Review</h2>' +
        stampHtml +
        '<p class="fp-step-desc">Check everything before submitting. This cannot be edited after submission.</p>' +
        reviewSection("Student information", [
          ["Name", p.student_name], ["Father's name", p.father_name], ["Father's profession", p.father_profession],
          ["Contact", p.contact], ["Discipline", p.discipline], ["Section", p.section],
          ["Roll number", p.roll_number], ["Matric marks", p.matric_marks], ["FSc Part 1 marks", p.first_year_marks]
        ]) +
        reviewSection("Pathway", [["Selected", state.pathway === "medical" ? "Medical / Health Sciences" : "Engineering / Non-Medical"]]) +
        '<div class="fp-review-section"><h4>Institute preferences</h4>' + instHtml + '</div>' +
        '<div class="fp-review-section"><h4>Faculty preferences</h4>' + facHtml + '</div>' +
        reviewSection("Additional information", [["Notes", state.additionalInfo || "\u2014"]]);

      function reviewSection(title, rows){
        return '<div class="fp-review-section"><h4>' + title + '</h4>' +
          rows.map(function(r){ return '<div class="fp-review-row"><span>' + r[0] + '</span><span>' + esc(r[1] || "\u2014") + '</span></div>'; }).join("") +
          '</div>';
      }
    }
  };

  function ensureGroupArrays(){
    var n = groupCount();
    if(state.instituteGroups.length !== n){ state.instituteGroups = emptyGroups(n); state.instituteCustom = emptyCustom(n); }
    if(state.facultyGroups.length !== n){ state.facultyGroups = emptyGroups(n); state.facultyCustom = emptyCustom(n); }
  }

  // Preferences are grouped into 4 sets of 5 ranked slots (2 sets for
  // medical -- see groupCount()). Previously each group's UI numbered
  // its own slots 1-5 from scratch, so Group 2's "1st" choice actually
  // looked identical to Group 1's "1st" -- confusing, since it's really
  // the student's 6th choice overall. This gives each group a global
  // range label and numbers every slot by its true overall position.
  function priorityRange(gi){
    var start = gi * 5 + 1, end = gi * 5 + 5;
    return start + "\u2013" + end;
  }

  function prefGroupsHTML(kind, options, groups, customArr){
    return groups.map(function(ranks, gi){
      var dupes = findDupes(ranks);
      var ranksHtml = ranks.map(function(val, ri){
        var isDupe = val && dupes.indexOf(val) > -1;
        var uid = kind + "-" + gi + "-" + ri;
        // Searchable select: a text input filters the <select> options
        // live so you can type "NUST" instead of scrolling a long list.
        var searchHtml = '<input type="search" class="fp-pref-search" ' +
          'data-target="' + uid + '" ' +
          'placeholder="Type to search\u2026" autocomplete="off" ' +
          'tabindex="-1" ' +
          'style="margin-bottom:4px;">';
        var selectHtml = '<select id="' + uid + '" data-kind="' + kind + '" data-group="' + gi + '" data-rank="' + ri + '">' +
          '<option value="">select</option>' +
          options.map(function(o){
            var sel = (val === o.id) ? "selected" : "";
            return '<option value="' + o.id + '" ' + sel + '>' + esc(o.name) + (o.location ? " (" + esc(o.location) + ")" : "") + '</option>';
          }).join("") +
        '</select>';
        var customName = options.find(function(o){ return o.id === val; });
        var showCustom = customName && customName.name === "Other";
        var customInput = showCustom ?
          '<input type="text" placeholder="Name it" data-kind="' + kind + '-custom" data-group="' + gi + '" data-rank="' + ri + '" value="' + esc(customArr[gi][ri]) + '" style="max-width:160px;">' : "";
        return '<div class="fp-pref-rank ' + (isDupe?"has-dupe":"") + '"><span class="fp-rank-badge">' + (gi*5 + ri + 1) + '</span><div class="fp-pref-rank-inner">' + searchHtml + selectHtml + customInput + '</div></div>';
      }).join("");
      return '<div class="fp-pref-group"><h4>Preference group ' + (gi+1) + ' <span class="fp-hint">(' + priorityRange(gi) + ')</span></h4><div class="fp-pref-ranks">' + ranksHtml + '</div></div>';
    }).join("");
  }

  function findDupes(arr){
    var seen = {}, dupes = [];
    arr.forEach(function(v){
      if(!v) return;
      if(seen[v]) dupes.push(v); else seen[v] = true;
    });
    return dupes;
  }

  function groupsReviewHtml(groups, customArr, options){
    return groups.map(function(ranks, gi){
      var names = ranks.map(function(v, ri){
        if(!v) return null;
        var o = options.find(function(x){ return x.id === v; });
        var name = o ? o.name : v;
        if(name === "Other" && customArr[gi][ri]) name = customArr[gi][ri];
        return (gi*5 + ri + 1) + ". " + name;
      }).filter(Boolean).join(", ");
      return '<div class="fp-review-row"><span>Group ' + (gi+1) + ' (' + priorityRange(gi) + ')</span><span>' + esc(names || "\u2014") + '</span></div>';
    }).join("");
  }

  // ---------------------------------------------------------
  // Event binding per step
  // ---------------------------------------------------------
  // ---------------------------------------------------------
  // Duplicate-name check -- warns (doesn't block) when another
  // student record already has a similar name. Doesn't try to
  // decide whether it's the same person re-entered or a genuine
  // namesake -- just surfaces the possibility so a counsellor can
  // make that call themselves instead of it going unnoticed.
  //
  // Only ever finds anything when the signed-in account is
  // counsellor/admin -- RLS on `students` restricts a plain student
  // to their own row only ("id = auth.uid() or current_role() in
  // (...)"), so a genuine self-service student querying this always
  // gets an empty result back, not an error. That's fine: this
  // feature is only meaningful for the counsellor-managed workflow
  // this site actually runs on.
  // ---------------------------------------------------------
  function checkDuplicateName(name){
    var hint = document.getElementById("fp-duplicate-name-hint");
    if(!hint) return;
    var trimmed = (name || "").trim();
    if(trimmed.length < 3){
      hint.textContent = "";
      hint.className = "fp-field-hint";
      return;
    }
    FP.client.from("students")
      .select("id, student_name, future_pathways(pathway, status)")
      .ilike("student_name", "%" + trimmed + "%")
      .neq("id", state.studentId)
      .limit(5)
      .then(function(r){
        if(r.error || !r.data || !r.data.length){
          hint.textContent = "";
          hint.className = "fp-field-hint";
          return;
        }
        var others = r.data.map(function(s){
          var fp = (s.future_pathways && s.future_pathways[0]) || {};
          return titleCase(s.student_name) + (fp.pathway ? " (" + fp.pathway + ", " + fp.status + ")" : "");
        }).join("; ");
        hint.textContent = "\u26A0 " + r.data.length + " existing student" + (r.data.length === 1 ? "" : "s") +
          " with a similar name: " + others + " \u2014 confirm this is a different student, not a re-entry.";
        hint.className = "fp-field-hint is-warn";
      });
  }

  function bindStepEvents(step){
    var container = document.getElementById("fp-step-container");

    if(step === "profile"){
      var duplicateCheckTimer = null;

      container.querySelectorAll("[data-field]").forEach(function(input){
        input.addEventListener("input", function(){
          // Strip non-digits for the contact field and enforce 11-digit mask
          if(input.dataset.field === "contact"){
            var digits = input.value.replace(/\D/g, "").slice(0, 11);
            input.value = digits;
            state.profile.contact = digits;
            var hint = document.getElementById("fp-contact-hint");
            if(hint){
              if(digits.length === 0){
                hint.textContent = "";
                hint.className = "fp-field-hint";
              } else if(!digits.startsWith("03")){
                hint.textContent = "Pakistani mobile numbers start with 03 \u2014 e.g. 03214908865";
                hint.className = "fp-field-hint is-error";
              } else if(digits.length < 11){
                hint.textContent = (11 - digits.length) + " more digit" + (11 - digits.length === 1 ? "" : "s") + " needed \u2014 format: 03XX XXXXXXX";
                hint.className = "fp-field-hint is-warn";
              } else {
                hint.textContent = "\u2713 Looks good";
                hint.className = "fp-field-hint is-ok";
              }
            }
            return;
          }
          if(input.dataset.field === "student_name"){
            state.profile.student_name = input.value;
            // Debounced -- checks 500ms after typing pauses, not on
            // every keystroke, to avoid hammering the DB while
            // someone's still mid-name.
            clearTimeout(duplicateCheckTimer);
            duplicateCheckTimer = setTimeout(function(){ checkDuplicateName(input.value); }, 500);
            return;
          }
          state.profile[input.dataset.field] = input.value;
        });
      });
    }
    if(step === "pathway"){
      container.querySelectorAll("[data-pathway]").forEach(function(btn){
        btn.addEventListener("click", function(){
          state.pathway = btn.dataset.pathway;
          state.instituteGroups = emptyGroups(groupCount());
          state.instituteCustom = emptyCustom(groupCount());
          state.facultyGroups = emptyGroups(groupCount());
          state.facultyCustom = emptyCustom(groupCount());
          render();
        });
      });
    }
    if(step === "institutes" || step === "faculties"){
      container.querySelectorAll("select[data-kind]").forEach(function(sel){
        sel.addEventListener("change", function(){
          var gi = +sel.dataset.group, ri = +sel.dataset.rank;
          var target = sel.dataset.kind === "institute" ? state.instituteGroups : state.facultyGroups;
          target[gi][ri] = sel.value || null;
          render();
        });
      });
      container.querySelectorAll("input[data-kind$='-custom']").forEach(function(inp){
        inp.addEventListener("input", function(){
          var gi = +inp.dataset.group, ri = +inp.dataset.rank;
          var target = inp.dataset.kind.indexOf("institute") === 0 ? state.instituteCustom : state.facultyCustom;
          target[gi][ri] = inp.value;
        });
      });
      // Search filter -- type to narrow the select options, then click
      // the matching one. On selection, clears the search box so the
      // full list is visible again next time.
      container.querySelectorAll(".fp-pref-search").forEach(function(inp){
        var sel = document.getElementById(inp.dataset.target);
        if(!sel) return;
        var allOptions = Array.from(sel.options);

        // Focus search when the select above it is focused and user
        // starts typing -- makes the workflow: Tab to select, type
        // to filter, Enter/click to pick, Tab to next select.
        sel.addEventListener("focus", function(){
          inp.value = "";
          // Restore full list on focus so search starts fresh
          var cur = sel.value;
          while(sel.options.length) sel.remove(0);
          allOptions.forEach(function(opt){ sel.appendChild(opt.cloneNode(true)); });
          sel.value = cur;
        });

        // Typing while the SELECT is focused triggers the search filter
        sel.addEventListener("keydown", function(e){
          // Let Tab and arrow keys pass through normally
          if(e.key === "Tab" || e.key === "ArrowUp" || e.key === "ArrowDown" ||
             e.key === "Enter" || e.key === "Escape") return;
          // Any printable character: redirect focus to search input
          if(e.key.length === 1){
            e.preventDefault();
            inp.removeAttribute("tabindex");
            inp.focus();
            inp.value = e.key;
            inp.dispatchEvent(new Event("input"));
          }
        });

        inp.addEventListener("input", function(){
          var q = inp.value.trim().toLowerCase();
          // Rebuild option list -- show only matches, keep selected
          // value even if it's now filtered out (so state isn't lost)
          while(sel.options.length) sel.remove(0);
          allOptions.forEach(function(opt){
            if(!q || opt.text.toLowerCase().indexOf(q) !== -1){
              sel.appendChild(opt.cloneNode(true));
            }
          });
          // Auto-select if exactly one result (not the blank placeholder)
          var realOpts = Array.from(sel.options).filter(function(o){ return o.value; });
          if(realOpts.length === 1){
            sel.value = realOpts[0].value;
            sel.dispatchEvent(new Event("change"));
            inp.value = "";
            inp.setAttribute("tabindex", "-1");
            sel.focus();
            // Restore full list after auto-select
            while(sel.options.length) sel.remove(0);
            allOptions.forEach(function(opt){ sel.appendChild(opt.cloneNode(true)); });
            sel.value = realOpts[0].value;
          }
        });

        // On Escape in search: clear, restore full list, return focus to select
        inp.addEventListener("keydown", function(e){
          if(e.key === "Escape"){
            inp.value = "";
            inp.setAttribute("tabindex", "-1");
            var cur = sel.value;
            while(sel.options.length) sel.remove(0);
            allOptions.forEach(function(opt){ sel.appendChild(opt.cloneNode(true)); });
            sel.value = cur;
            sel.focus();
          }
        });

        sel.addEventListener("change", function(){
          inp.value = "";
          inp.setAttribute("tabindex", "-1");
          // Restore full option list when user picks from select
          var cur = sel.value;
          while(sel.options.length) sel.remove(0);
          allOptions.forEach(function(opt){ sel.appendChild(opt.cloneNode(true)); });
          sel.value = cur;
        });
      });
    }
    if(step === "additional"){
      document.getElementById("fp-additional").addEventListener("input", function(e){ state.additionalInfo = e.target.value; });
    }
  }

  // ---------------------------------------------------------
  // Validation per step
  // ---------------------------------------------------------
  function validateStep(step){
    if(step === "profile"){
      var p = state.profile;
      var required = ["student_name","father_name","contact","discipline","roll_number","matric_marks","first_year_marks"];
      var missing = required.filter(function(k){ return !p[k] && p[k] !== 0; });
      if(missing.length) return "Please fill in all required student information fields.";
      // Contact-specific validation: must be exactly 11 digits starting with 03
      var contact = String(p.contact || "").replace(/\D/g,"");
      if(contact.length !== 11) return "Contact number must be exactly 11 digits \u2014 e.g. 03214908865.";
      if(!contact.startsWith("03")) return "Contact number must start with 03 \u2014 e.g. 03214908865.";
    }
    if(step === "pathway" && !state.pathway) return "Please select a pathway to continue.";
    if(step === "institutes" || step === "faculties"){
      var groups = step === "institutes" ? state.instituteGroups : state.facultyGroups;
      for(var i=0;i<groups.length;i++){
        if(findDupes(groups[i]).length) return "Remove duplicate selections within preference group " + (i+1) + ".";
      }
    }
    return null;
  }

  // ---------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------
  function ensureFuturePathwayRow(){
    if(state.futurePathwayId) return Promise.resolve(state.futurePathwayId);
    return FP.client.from("future_pathways").insert([{
      student_id: state.studentId, pathway: state.pathway || "engineering", status: "draft"
    }]).select().single().then(function(r){
      if(r.error){ throw r.error; }
      state.futurePathwayId = r.data.id;
      state.status = "draft";
      return state.futurePathwayId;
    });
  }

  function saveProfile(){
    var record = Object.assign({ id: state.studentId }, state.profile);
    return FP.client.from("students").upsert([record]).then(function(r){
      if(r.error) throw r.error;
    });
  }

  function saveDraftShell(){
    return ensureFuturePathwayRow().then(function(id){
      var patch = { additional_information: state.additionalInfo };
      if(state.pathway) patch.pathway = state.pathway;
      return FP.client.from("future_pathways").update(patch).eq("id", id).then(function(r){ if(r.error) throw r.error; });
    });
  }

  function savePreferences(){
    if(!state.futurePathwayId) return Promise.resolve();
    var fpId = state.futurePathwayId;
    var instRows = [];
    state.instituteGroups.forEach(function(ranks, gi){
      ranks.forEach(function(val, ri){
        if(!val) return;
        var opt = state.allInstitutes.find(function(o){ return o.id === val; });
        instRows.push({
          future_pathway_id: fpId, preference_group: gi+1, rank: ri+1,
          institute_id: val,
          custom_institute_name: (opt && opt.name === "Other") ? (state.instituteCustom[gi][ri] || null) : null
        });
      });
    });
    var facRows = [];
    state.facultyGroups.forEach(function(ranks, gi){
      ranks.forEach(function(val, ri){
        if(!val) return;
        var opt = state.allFaculties.find(function(o){ return o.id === val; });
        facRows.push({
          future_pathway_id: fpId, preference_group: gi+1, rank: ri+1,
          faculty_id: val,
          custom_faculty_name: (opt && opt.name === "Other") ? (state.facultyCustom[gi][ri] || null) : null
        });
      });
    });
    var progRows = []; // career step removed; program_preferences no longer written

    return Promise.all([
      FP.client.from("student_institute_preferences").delete().eq("future_pathway_id", fpId),
      FP.client.from("student_faculty_preferences").delete().eq("future_pathway_id", fpId)
    ]).then(function(){
      var ops = [];
      if(instRows.length) ops.push(FP.client.from("student_institute_preferences").insert(instRows));
      if(facRows.length) ops.push(FP.client.from("student_faculty_preferences").insert(facRows));
      return Promise.all(ops);
    });
  }

  function persistStep(step){
    if(step === "profile") return saveProfile().then(saveDraftShell);
    if(step === "pathway" || step === "additional") return saveDraftShell();
    if(step === "institutes" || step === "faculties") return saveDraftShell().then(savePreferences);
    return Promise.resolve();
  }

  function submit(){
    var stamp = new Date();
    return FP.client.from("future_pathways").update({
      status: "submitted", submitted_at: stamp.toISOString()
    }).eq("id", state.futurePathwayId).then(function(r){
      if(r.error) throw r.error;
      state.status = "submitted";
      state.submittedAt = stamp;
    });
  }

  // ---------------------------------------------------------
  // Nav
  // ---------------------------------------------------------
  document.getElementById("fp-back").addEventListener("click", function(){
    if(state.stepIndex > 0){ state.stepIndex--; render(); }
  });

  document.getElementById("fp-next").addEventListener("click", function(){
    if((state.status === "submitted" && !state.actingAsStaff) || state.saving) return;
    var step = STEPS[state.stepIndex];
    var err = validateStep(step);
    if(err){
      if(FP.toast) FP.toast.error(err);
      else alert(err);
      return;
    }

    state.saving = true;
    var nextBtn = document.getElementById("fp-next");
    nextBtn.disabled = true;

    persistStep(step).then(function(){
      if(step === "review"){
        return submit();
      }
      state.stepIndex++;
    }).then(function(){
      state.saving = false;
      render();
    }).catch(function(e){
      console.error(e);
      state.saving = false;
      nextBtn.disabled = false;
      if(FP.toast) FP.toast.error("Something went wrong saving that step: " + (e.message || e));
      else alert("Something went wrong saving that step: " + (e.message || e));
    });
  });
})();
