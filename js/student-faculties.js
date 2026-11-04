/* =========================================================
   student-faculties.js -- "View Student Faculties" admin page.

   Mirrors the priority-cycling feature built for institute
   preferences on admin.html (js/fp-admin.js), but reads
   student_faculty_preferences instead of student_institute_
   preferences. Deliberately kept separate rather than merged
   into fp-admin.js/admin.html -- this is a focused, read-only
   view (no bulk actions, no CSV export, no delete), not another
   copy of the full submissions table.
   ========================================================= */
(function(){
  var submissions = [];       // [{ id, student_id, pathway, status, students: {student_name} }]
  var facultyLookup = {};     // faculty_id -> name
  var facultyByFpId = {};     // future_pathway_id -> faculty name (or custom name) at the CURRENT priorityN
  var priorityN = 1;          // which preference position (1-20) is currently shown

  // ---------------------------------------------------------
  // Same flattened-position math as fp-admin.js: preferences are
  // stored as 4 groups of 5 ranked slots each (2 groups for
  // medical, per groupCount() in fp-app.js) -- 20 total positions
  // for most pathways, 10 for medical.
  // ---------------------------------------------------------
  function groupRankFromPriority(n){
    return { group: Math.floor((n - 1) / 5) + 1, rank: ((n - 1) % 5) + 1 };
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

  function esc(s){
    return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
  }

  // Source data (real school records) has names in ALL CAPS
  function titleCase(s){
    return String(s || "").toLowerCase().replace(/\b\w/g, function(c){ return c.toUpperCase(); });
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

    fetchFaculties();
    fetchSubmissions();
  }).catch(function(e){ console.error(e); });

  // ---------------------------------------------------------
  // Data -- each fetch owns its own failure/retry, same pattern
  // as fp-admin.js's graceful-degradation setup. A failed faculty
  // lookup just means names show blank, not that the whole page
  // breaks; a failed submissions fetch is the one that matters,
  // so it gets a visible retry.
  // ---------------------------------------------------------
  function fetchFaculties(){
    return FP.client.from("fp_faculties").select("id,name").then(function(r){
      if(r.error) throw r.error;
      facultyLookup = {};
      (r.data || []).forEach(function(f){ facultyLookup[f.id] = f.name; });
      return fetchPriorityFaculties();
    }).catch(function(e){
      console.error("Faculty lookup failed to load:", e);
    });
  }

  function fetchSubmissions(){
    return FP.client.from("future_pathways").select("id, student_id, pathway, status, students(student_name)")
      .order("created_at", { ascending:false })
      .then(function(r){
        if(r.error) throw r.error;
        submissions = r.data || [];
        renderTable();
      }).catch(function(e){
        console.error(e);
        FP.toast.error("Couldn't load students. Check your connection and try again.");
      });
  }

  function fetchPriorityFaculties(){
    var gr = groupRankFromPriority(priorityN);
    return FP.client.from("student_faculty_preferences")
      .select("future_pathway_id, faculty_id, custom_faculty_name")
      .eq("preference_group", gr.group).eq("rank", gr.rank)
      .then(function(r){
        if(r.error) throw r.error;
        applyPriorityFaculties(r);
      }).catch(function(e){
        console.error(e);
      });
  }

  function applyPriorityFaculties(r){
    facultyByFpId = {}; // reset -- otherwise switching ranks leaves stale names for students without a preference at the new rank
    (r.data || []).forEach(function(row){
      var name = row.custom_faculty_name || facultyLookup[row.faculty_id] || null;
      if(name) facultyByFpId[row.future_pathway_id] = name;
    });

    var usedNames = Array.from(new Set(Object.values(facultyByFpId))).sort();
    var select = document.getElementById("sf-filter-priority");
    select.innerHTML = '<option value="">All</option>' +
      usedNames.map(function(n){ return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join("");

    document.getElementById("sf-priority-label").textContent = ordinal(priorityN) + " priority faculty";
    document.getElementById("sf-priority-col-label").textContent = ordinal(priorityN) + " Priority Faculty";

    renderTable();
  }

  // ---------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------
  function getFilteredRows(){
    var nameFilter = document.getElementById("sf-filter-name").value.trim().toLowerCase();
    var pathwayFilter = document.getElementById("sf-filter-pathway").value;
    var priorityFilter = document.getElementById("sf-filter-priority").value;

    return submissions.filter(function(s){
      var name = titleCase((s.students && s.students.student_name) || "");
      return (!nameFilter || name.toLowerCase().indexOf(nameFilter) !== -1)
        && (!pathwayFilter || s.pathway === pathwayFilter)
        && (!priorityFilter || facultyByFpId[s.id] === priorityFilter);
    });
  }

  function renderTable(){
    var rows = getFilteredRows();

    var tbody = document.getElementById("sf-tbody");
    tbody.innerHTML = rows.map(function(s){
      var name = titleCase((s.students && s.students.student_name) || "") || "(no profile yet)";
      var faculty = facultyByFpId[s.id] || "\u2014";
      return '<tr data-id="' + s.id + '">' +
        '<td><strong>' + esc(name) + '</strong></td>' +
        '<td class="fp-cap">' + esc(s.pathway) + '</td>' +
        '<td>' + esc(faculty) + '</td>' +
        '<td><span class="fp-badge ' + esc(s.status) + '">' + esc(s.status) + '</span></td>' +
      '</tr>';
    }).join("");

    document.getElementById("sf-empty-hint").hidden = rows.length > 0;

    // Clicking a row opens the SAME detail view admin.html uses --
    // rather than duplicating renderDetail's ~150 lines here, this
    // just navigates to admin.html with a ?open=<id> param that its
    // own applySubmissions() checks for on load (see fp-admin.js).
    document.querySelectorAll("#sf-tbody tr[data-id]").forEach(function(tr){
      tr.addEventListener("click", function(){
        window.location.href = "admin.html?open=" + encodeURIComponent(tr.dataset.id);
      });
    });
  }

  document.getElementById("sf-filter-name").addEventListener("input", renderTable);
  document.getElementById("sf-filter-pathway").addEventListener("change", renderTable);
  document.getElementById("sf-filter-priority").addEventListener("change", renderTable);

  // ---------------------------------------------------------
  // Prev / Next -- steps priorityN backward or forward, wrapping
  // at both ends (20 -> 1 going forward, 1 -> 20 going back).
  // ---------------------------------------------------------
  function stepPriority(delta){
    priorityN = priorityN + delta;
    if(priorityN > 20) priorityN = 1;
    if(priorityN < 1) priorityN = 20;
    document.getElementById("sf-filter-priority").value = ""; // old selection may not exist at the new rank

    var prevBtn = document.getElementById("sf-priority-prev");
    var nextBtn = document.getElementById("sf-priority-next");
    prevBtn.disabled = true; nextBtn.disabled = true;
    fetchPriorityFaculties().finally(function(){
      prevBtn.disabled = false; nextBtn.disabled = false;
    });
  }

  document.getElementById("sf-priority-prev").addEventListener("click", function(){ stepPriority(-1); });
  document.getElementById("sf-priority-next").addEventListener("click", function(){ stepPriority(1); });

  // ---------------------------------------------------------
  // Print -- same hidden-iframe technique as admin.html's printout
  // (no visible new tab, straight to the OS/browser print dialog).
  // Always reflects whichever of the 20 preference positions is
  // currently selected, same as the on-screen table.
  // ---------------------------------------------------------
  document.getElementById("sf-print-list").addEventListener("click", function(){
    var rows = getFilteredRows();
    if(!rows.length){
      FP.toast.info("No students match the current filters to print.");
      return;
    }

    var priorityColLabel = ordinal(priorityN) + " Priority Faculty";
    var generatedAt = new Date().toLocaleString(undefined, {
      year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit"
    });

    var rowsHtml = rows.map(function(s){
      var name = titleCase((s.students && s.students.student_name) || "");
      var faculty = facultyByFpId[s.id] || "\u2014";
      return "<tr>" +
        "<td>" + esc(name) + "</td>" +
        "<td class=\"cap\">" + esc(s.pathway) + "</td>" +
        "<td>" + esc(faculty) + "</td>" +
        "<td class=\"cap\">" + esc(s.status) + "</td>" +
      "</tr>";
    }).join("");

    var doc =
      "<!DOCTYPE html><html><head><meta charset=\"UTF-8\">" +
      "<title>Student Faculties</title>" +
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
        ".cap{ text-transform:capitalize; }" +
        "tr{ page-break-inside: avoid; }" +
        ".report-footer{ margin-top:14px; font-size:10px; color:#888; text-align:right; }" +
      "</style></head><body>" +
      "<div class=\"report-header\">" +
        "<div class=\"report-title\">NORTHLINE | Student Faculties</div>" +
        "<div class=\"report-meta\">KIPS Counsellor Office<br>Generated " + esc(generatedAt) + "</div>" +
      "</div>" +
      "<div class=\"report-filters\">" + rows.length + " student" + (rows.length === 1 ? "" : "s") + "</div>" +
      "<table><thead><tr>" +
        "<th>Student</th><th>Pathway</th><th>" + esc(priorityColLabel) + "</th><th>Status</th>" +
      "</tr></thead><tbody>" + rowsHtml + "</tbody></table>" +
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
