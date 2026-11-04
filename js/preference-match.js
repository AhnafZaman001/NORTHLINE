/* =========================================================
   preference-match.js -- "Preference match" admin page.

   Different from admin.html's University preferences and
   student-faculties.html's Faculty preferences pages, which each
   show ONE rank position (1st, 5th, 12th...) across ALL students at
   a time. This page instead searches for a SPECIFIC university
   and/or faculty and finds every student who listed it ANYWHERE in
   their 20 ranked positions, showing exactly which position each
   landed at.
   ========================================================= */
(function(){
  var institutes = [];   // [{id, name, pathway}]
  var faculties = [];    // [{id, name, pathway}]
  var results = [];      // built by runSearch()

  function esc(s){
    return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
  }
  function titleCase(s){
    return String(s || "").toLowerCase().replace(/\b\w/g, function(c){ return c.toUpperCase(); });
  }
  function ordinal(n){
    var rem100 = n % 100;
    if(rem100 >= 11 && rem100 <= 13) return n + "th";
    switch(n % 10){
      case 1: return n + "st";
      case 2: return n + "nd";
      case 3: return n + "rd";
      default: return n + "th";
    }
  }

  var authPromise = FP.getSessionAndProfile();

  authPromise.then(function(result){
    if(!result){ window.location.href = "login.html"; return; }

    var role = result.profile ? result.profile.role : "student";
    if(role !== "counsellor" && role !== "admin"){
      window.location.href = "access-denied.html";
      return;
    }

    document.getElementById("fp-logout").addEventListener("click", function(){ FP.signOut(); });

    loadOptions();
  }).catch(function(e){ console.error(e); });

  function loadOptions(){
    Promise.all([
      FP.client.from("institutes").select("id, name, pathway").eq("active", true).order("name"),
      FP.client.from("fp_faculties").select("id, name, pathway").eq("active", true).order("name"),
    ]).then(function(res){
      if(res[0].error) throw res[0].error;
      if(res[1].error) throw res[1].error;
      institutes = res[0].data || [];
      faculties = res[1].data || [];
      populateSelects();
    }).catch(function(err){
      console.error(err);
      FP.toast.error("Couldn't load the university/faculty lists. Refresh and try again.");
    });
  }

  function populateSelects(){
    var pathway = document.getElementById("pm-pathway").value;
    var uniSel = document.getElementById("pm-university");
    var facSel = document.getElementById("pm-faculty");
    var prevUni = uniSel.value, prevFac = facSel.value;

    var uniList = institutes.filter(function(i){ return !pathway || i.pathway === pathway; });
    var facList = faculties.filter(function(f){ return !pathway || f.pathway === pathway; });

    uniSel.innerHTML = '<option value="">\u2014 Any university \u2014</option>' +
      uniList.map(function(i){ return '<option value="' + i.id + '">' + esc(i.name) + '</option>'; }).join("");
    facSel.innerHTML = '<option value="">\u2014 Any faculty \u2014</option>' +
      facList.map(function(f){ return '<option value="' + f.id + '">' + esc(f.name) + '</option>'; }).join("");

    // Keep the previous pick selected if it's still a valid option
    // after a pathway change; otherwise reset to "Any".
    uniSel.value = uniList.some(function(i){ return i.id === prevUni; }) ? prevUni : "";
    facSel.value = facList.some(function(f){ return f.id === prevFac; }) ? prevFac : "";

    // Rewire the searchable-select mechanism against the freshly
    // rebuilt option lists (see wireSearchableSelect below).
    wireSearchableSelect("pm-university-search", "pm-university", runSearch);
    wireSearchableSelect("pm-faculty-search", "pm-faculty", runSearch);
  }

  // Exact same searchable-select mechanism as the student form on
  // pathways.html (js/fp-app.js) -- ported over rather than
  // reimplemented, so the interaction feels identical everywhere on
  // the site:
  //   - Tab into the <select> and start typing -> focus jumps to the
  //     paired search input, first keystroke carries over
  //   - Typing filters the select's options live; narrowing to
  //     exactly one match auto-selects it and returns focus to the
  //     select
  //   - Escape clears the search and restores the full option list
  //   - Picking an option (however it happened) resets the search
  //     box and restores the full list for next time
  //
  // Takes IDs rather than element references because it clones and
  // replaces BOTH the input and the select on every call -- this is
  // called again each time the Pathway filter changes the underlying
  // option list, and cloning is what cleanly drops the previous
  // call's listeners instead of stacking duplicates on top (which
  // would otherwise happen on the select as much as the input, since
  // this mechanism attaches listeners to both).
  function wireSearchableSelect(inputId, selectId, onChange){
    var oldInput = document.getElementById(inputId);
    var oldSelect = document.getElementById(selectId);
    if(!oldInput || !oldSelect) return;

    var inp = oldInput.cloneNode(true);
    oldInput.parentNode.replaceChild(inp, oldInput);
    var sel = oldSelect.cloneNode(true);
    oldSelect.parentNode.replaceChild(sel, oldSelect);

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
      if(onChange) onChange();
    });
  }

  document.getElementById("pm-pathway").addEventListener("change", function(){
    populateSelects();
    runSearch();
  });
  // Note: no separate change listeners for pm-university/pm-faculty
  // here -- wireSearchableSelect() attaches those itself (via its
  // onChange callback) to whichever select node is currently live,
  // since it replaces the select element on every populateSelects()
  // call. A listener attached here to the original nodes would go
  // stale the moment the first clone-and-replace happens.

  function runSearch(){
    var uniId = document.getElementById("pm-university").value;
    var facId = document.getElementById("pm-faculty").value;
    var resultsCard = document.getElementById("pm-results-card");
    var prompt = document.getElementById("pm-prompt");

    if(!uniId && !facId){
      resultsCard.hidden = true;
      prompt.hidden = false;
      return;
    }
    prompt.hidden = true;
    resultsCard.hidden = false;

    var tbody = document.getElementById("pm-tbody");
    tbody.innerHTML = '<tr><td colspan="5" class="fp-hint">Searching\u2026</td></tr>';

    Promise.all([
      uniId
        ? FP.client.from("student_institute_preferences").select("future_pathway_id, preference_group, rank").eq("institute_id", uniId)
        : Promise.resolve({ data: [] }),
      facId
        ? FP.client.from("student_faculty_preferences").select("future_pathway_id, preference_group, rank").eq("faculty_id", facId)
        : Promise.resolve({ data: [] }),
    ]).then(function(res){
      if(res[0].error) throw res[0].error;
      if(res[1].error) throw res[1].error;

      var uniByFp = {}; // future_pathway_id -> global rank position (1-20)
      (res[0].data || []).forEach(function(r){
        uniByFp[r.future_pathway_id] = (r.preference_group - 1) * 5 + r.rank;
      });
      var facByFp = {};
      (res[1].data || []).forEach(function(r){
        facByFp[r.future_pathway_id] = (r.preference_group - 1) * 5 + r.rank;
      });

      // When both a university AND a faculty are picked, only
      // students with BOTH count as a match (intersection). When
      // only one is picked, every match on that one criterion shows,
      // with the other column simply not rendered.
      var matchIds;
      if(uniId && facId){
        matchIds = Object.keys(uniByFp).filter(function(fpId){ return facByFp.hasOwnProperty(fpId); });
      } else if(uniId){
        matchIds = Object.keys(uniByFp);
      } else {
        matchIds = Object.keys(facByFp);
      }

      if(!matchIds.length){
        results = [];
        renderResults([], uniId, facId, uniByFp, facByFp);
        return;
      }

      return FP.client.from("future_pathways")
        .select("id, pathway, status, students(student_name)")
        .in("id", matchIds)
        .then(function(r){
          if(r.error) throw r.error;
          results = r.data || [];
          renderResults(results, uniId, facId, uniByFp, facByFp);
        });
    }).catch(function(err){
      console.error(err);
      tbody.innerHTML = '<tr><td colspan="5" class="fp-error">Search failed. Try again.</td></tr>';
    });
  }

  function renderResults(rows, uniId, facId, uniByFp, facByFp){
    var uniName = uniId ? (institutes.find(function(i){ return i.id === uniId; }) || {}).name : null;
    var facName = facId ? (faculties.find(function(f){ return f.id === facId; }) || {}).name : null;

    var titleParts = [];
    if(uniName) titleParts.push(esc(uniName));
    if(facName) titleParts.push(esc(facName));
    document.getElementById("pm-results-title").textContent =
      titleParts.join(" + ") + " \u2014 " + rows.length + " student" + (rows.length === 1 ? "" : "s");

    document.getElementById("pm-th-university").hidden = !uniId;
    document.getElementById("pm-th-faculty").hidden = !facId;

    var tbody = document.getElementById("pm-tbody");
    tbody.innerHTML = rows.map(function(s){
      var name = titleCase((s.students && s.students.student_name) || "") || "(no profile yet)";
      var uniCell = uniId ? '<td>' + (uniByFp[s.id] ? ordinal(uniByFp[s.id]) : "\u2014") + '</td>' : "";
      var facCell = facId ? '<td>' + (facByFp[s.id] ? ordinal(facByFp[s.id]) : "\u2014") + '</td>' : "";
      return '<tr data-id="' + s.id + '">' +
        '<td><strong>' + esc(name) + '</strong></td>' +
        '<td class="fp-cap">' + esc(s.pathway) + '</td>' +
        uniCell + facCell +
        '<td><span class="fp-badge ' + esc(s.status) + '">' + esc(s.status) + '</span></td>' +
      '</tr>';
    }).join("");

    document.getElementById("pm-empty-hint").hidden = rows.length > 0;

    // Clicking a row opens the same detail view admin.html uses --
    // same pattern as student-faculties.html's rows.
    document.querySelectorAll("#pm-tbody tr[data-id]").forEach(function(tr){
      tr.addEventListener("click", function(){
        window.location.href = "admin.html?open=" + encodeURIComponent(tr.dataset.id);
      });
    });
  }

  // ---------------------------------------------------------
  // Print -- same hidden-iframe technique used on admin.html and
  // student-faculties.html (no visible new tab, straight to the
  // print dialog).
  // ---------------------------------------------------------
  document.getElementById("pm-print").addEventListener("click", function(){
    if(!results.length){
      FP.toast.info("No results to print.");
      return;
    }
    var title = document.getElementById("pm-results-title").textContent;

    // Clone the already-rendered result table straight into the print
    // document -- renderResults() already put the correct ordinal
    // text in each cell, so there's no need to re-derive anything here.
    var tableClone = document.getElementById("pm-table").outerHTML;

    var generatedAt = new Date().toLocaleString(undefined, {
      year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit"
    });

    var doc =
      "<!DOCTYPE html><html><head><meta charset=\"UTF-8\">" +
      "<title>Preference Match</title>" +
      "<style>" +
        "@page{ size: A4 landscape; margin: 16mm 14mm; }" +
        "*{ box-sizing:border-box; }" +
        "body{ font-family: -apple-system, 'Segoe UI', Inter, Arial, sans-serif; color:#1a1a1a; margin:0; padding:0; -webkit-print-color-adjust:exact; print-color-adjust:exact; }" +
        ".report-header{ display:flex; align-items:baseline; justify-content:space-between; border-bottom:2px solid #1a1a1a; padding-bottom:10px; margin-bottom:4px; }" +
        ".report-title{ font-size:18px; font-weight:700; letter-spacing:-0.01em; }" +
        ".report-meta{ font-size:11px; color:#555; text-align:right; }" +
        ".report-filters{ font-size:11px; color:#555; margin:6px 0 16px; }" +
        "table{ width:100%; border-collapse:collapse; font-size:12px; }" +
        "thead th{ text-align:left; background:#f0f0f0; border:1px solid #ccc; padding:6px 8px; font-weight:600; }" +
        "tbody td{ border:1px solid #ddd; padding:6px 8px; }" +
        "tbody tr:nth-child(even){ background:#fafafa; }" +
        ".fp-cap{ text-transform:capitalize; }" +
        ".fp-badge{ display:inline-block; padding:1px 6px; border-radius:99px; font-size:10px; border:1px solid #999; }" +
        "tr{ page-break-inside: avoid; }" +
        ".report-footer{ margin-top:14px; font-size:10px; color:#888; text-align:right; }" +
      "</style></head><body>" +
      "<div class=\"report-header\">" +
        "<div class=\"report-title\">NORTHLINE | Preference Match</div>" +
        "<div class=\"report-meta\">KIPS Counsellor Office<br>Generated " + esc(generatedAt) + "</div>" +
      "</div>" +
      "<div class=\"report-filters\">" + esc(title) + "</div>" +
      tableClone +
      "<div class=\"report-footer\">NORTHLINE | KIPS College</div>" +
      "</body></html>";

    var iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.left = "-10000px";
    iframe.style.top = "-10000px";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    document.body.appendChild(iframe);

    var idoc = iframe.contentWindow.document;
    idoc.open();
    idoc.write(doc);
    idoc.close();

    function cleanup(){
      if(iframe.parentNode) iframe.parentNode.removeChild(iframe);
    }
    iframe.contentWindow.onafterprint = cleanup;
    setTimeout(cleanup, 15000);

    setTimeout(function(){
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    }, 250);
  });
})();
