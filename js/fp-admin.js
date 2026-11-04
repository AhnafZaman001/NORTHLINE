/* =========================================================
   fp-admin.js — counsellor/admin view of NORTHLINE
   submissions. RLS on the tables enforces access server-side;
   this client-side gate only avoids showing a confusing blank
   page to students who land here by mistake.
   ========================================================= */

(function(){
  var submissions = [];
  var lookups = { institutes:{}, faculties:{}, careers:{} };
  var firstPriorityByFpId = {}; // future_pathway_id -> institute name (or custom name) at the CURRENT priorityN
  var priorityN = 1; // which preference position (1-20) the "priority" column/filter currently shows
  var currentUserId = null; // the signed-in counsellor/admin's own id -- see
    // the self-row handling in renderTable()/the delete handler below.

  // ---------------------------------------------------------
  // Graceful degradation: each fetch below owns its own data,
  // its own failure, and its own retry -- none of them are
  // chained off each other, so a failure in one (say, the
  // institutes lookup) can't take the whole page down with it.
  // Previously this was one long .then() chain with a single
  // top-level .catch(); if any link failed, everything after it
  // -- including the submissions table itself -- silently never
  // rendered, and the counsellor was left staring at an empty
  // page with no explanation. Now each piece resolves (or fails
  // and shows its own inline retry) independently, in parallel.
  // ---------------------------------------------------------
  function fetchInstitutes(){
    return FP.client.from("institutes").select("id,name").order("name").then(function(r){
      if(r.error) throw r.error;
      lookups.institutes = {};
      (r.data||[]).forEach(function(x){ lookups.institutes[x.id] = x.name; });
      return fetchFirstPriorities(); // depends on institutes for name resolution
    }).catch(function(e){
      console.error(e);
      showSectionError("fp-lookups-error", "Some institute/program names may show as blank " +
        "-- the name lookups didn't load.", fetchInstitutes);
    });
  }

  function fetchFacultiesAndCareers(){
    return Promise.all([
      FP.client.from("fp_faculties").select("id,name"),
      FP.client.from("career_options").select("id,name")
    ]).then(function(rest){
      if(rest[0].error) throw rest[0].error;
      if(rest[1].error) throw rest[1].error;
      lookups.faculties = {}; lookups.careers = {};
      (rest[0].data||[]).forEach(function(x){ lookups.faculties[x.id] = x.name; });
      (rest[1].data||[]).forEach(function(x){ lookups.careers[x.id] = x.name; });
    }).catch(function(e){
      console.error(e);
      showSectionError("fp-lookups-error", "Some faculty/career names may show as blank " +
        "-- the name lookups didn't load.", fetchFacultiesAndCareers);
    });
  }

  // Preferences are stored as 4 groups of 5 ranked slots each (2 groups
  // for medical, per groupCount() in fp-app.js) -- 20 total positions
  // for most pathways. priorityN (1-20) is the flattened linear
  // position across that grid; this maps it back to the actual
  // (preference_group, rank) pair the DB uses.
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

  function fetchFirstPriorities(){
    var gr = groupRankFromPriority(priorityN);
    return FP.client.from("student_institute_preferences")
      .select("future_pathway_id, institute_id, custom_institute_name")
      .eq("preference_group", gr.group).eq("rank", gr.rank)
      .then(function(r){
        if(r.error) throw r.error;
        applyFirstPriorities(r);
      }).catch(function(e){
        console.error(e);
        // Non-fatal -- the priority filter dropdown just stays
        // empty/stale; the submissions table itself is unaffected.
      });
  }

  function fetchSubmissions(){
    hideSectionError("fp-submissions-error");
    return FP.client.from("future_pathways").select("*, students(*)").order("created_at", { ascending:false })
      .then(function(r){
        if(r.error) throw r.error;
        applySubmissions(r);
      }).catch(function(e){
        console.error(e);
        showSectionError("fp-submissions-error",
          "Couldn't load submissions. Check your connection and try again.", fetchSubmissions);
      });
  }

  var authPromise = FP.getSessionAndProfile();

  authPromise.then(function(result){
    if(!result){ window.location.href = "login.html"; return; } // requireAuth's redirect, inlined

    var role = result.profile ? result.profile.role : "student";
    if(role !== "counsellor" && role !== "admin"){
      window.location.href = "access-denied.html";
      return;
    }

    currentUserId = result.session.user.id;

    // All independent, all fire together -- a slow or failed lookup
    // fetch no longer holds up the submissions table rendering.
    fetchInstitutes();
    fetchFacultiesAndCareers();
    fetchSubmissions();
  }).catch(function(e){ console.error(e); });

  /** Shows a small inline error banner with a Retry button inside a
   *  named section. Reuses the same banner element on repeat calls
   *  instead of stacking duplicates. */
  function showSectionError(id, message, retryFn){
    var host = document.getElementById("fp-admin-list-view") || document.body;
    var el = document.getElementById(id);
    if(!el){
      el = document.createElement("div");
      el.id = id;
      el.className = "fp-error-banner";
      host.insertBefore(el, host.firstChild);
    }
    el.innerHTML = '<span>' + esc(message) + '</span>' +
      '<button type="button" class="btn-secondary fp-error-banner-retry">Retry</button>';
    el.hidden = false;
    el.querySelector(".fp-error-banner-retry").addEventListener("click", function(){
      el.querySelector(".fp-error-banner-retry").disabled = true;
      Promise.resolve(retryFn()).finally(function(){
        if(el.parentNode) el.querySelector(".fp-error-banner-retry").disabled = false;
      });
    });
  }

  function hideSectionError(id){
    var el = document.getElementById(id);
    if(el) el.hidden = true;
  }

  document.getElementById("fp-logout").addEventListener("click", function(){
    FP.signOut();
  });

  // "+ Add new student" -- also available directly from admin.html
  // now, alongside the one already on pathways.html itself. Same
  // RPC + redirect either place: create the account, then land on
  // pathways.html?student=<id> to actually fill in the student's
  // info -- data entry always happens on the form page regardless
  // of where you started, this just saves a trip through the list
  // view first if you're already looking at it.
  var addStudentBtn = document.getElementById("fp-admin-add-student");
  if(addStudentBtn){
    addStudentBtn.addEventListener("click", function(){
      addStudentBtn.disabled = true;
      addStudentBtn.textContent = "Creating\u2026";
      FP.client.rpc("counsellor_create_student").then(function(r){
        if(r.error){
          FP.toast.error("Could not create student: " + r.error.message);
          addStudentBtn.disabled = false;
          addStudentBtn.textContent = "+ Add new student";
          return;
        }
        FP.toast.success("Student account created");
        window.location.href = "pathways.html?student=" + encodeURIComponent(r.data);
      });
    });
  }

  // Print / Save as PDF
  var printBtn = document.getElementById("fp-print-list");
  if(printBtn){
    printBtn.addEventListener("click", function(){
      printSubmissions();
    });
  }

  function printSubmissions(){
    var filtered = sortRows(getFilteredSubmissions());
    if(!filtered.length){
      FP.toast.info("No submissions match the current filters to print.");
      return;
    }

    var pathwayFilter = document.getElementById("filter-pathway").value;
    var statusFilter = document.getElementById("filter-status").value;
    var priorityFilterVal = document.getElementById("filter-first-priority").value;
    var filterBits = [];
    if(pathwayFilter) filterBits.push("Pathway: " + titleCase(pathwayFilter));
    if(statusFilter) filterBits.push("Status: " + titleCase(statusFilter));
    if(priorityFilterVal) filterBits.push(ordinal(priorityN) + " priority: " + priorityFilterVal);
    var filterSummary = filterBits.length ? filterBits.join("  |  ") : "All students";

    var priorityColLabel = ordinal(priorityN) + " Priority";
    var generatedAt = new Date().toLocaleString(undefined, {
      year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit"
    });

    var rowsHtml = filtered.map(function(s){
      var p = s.students || {};
      return "<tr>" +
        "<td>" + esc(titleCase(p.student_name || "")) + "</td>" +
        "<td>" + esc(titleCase(p.father_name || "")) + "</td>" +
        "<td>" + esc(p.contact || "\u2014") + "</td>" +
        "<td>" + esc(p.roll_number || "\u2014") + "</td>" +
        "<td>" + esc(p.matric_marks != null ? p.matric_marks : "\u2014") + "</td>" +
        "<td>" + esc(p.first_year_marks != null ? p.first_year_marks : "\u2014") + "</td>" +
        "<td class=\"cap\">" + esc(s.pathway || "\u2014") + "</td>" +
        "<td>" + esc(firstPriorityByFpId[s.id] || "\u2014") + "</td>" +
        "<td class=\"cap\">" + esc(s.status || "\u2014") + "</td>" +
        "<td>" + (s.submitted_at ? esc(new Date(s.submitted_at).toLocaleDateString()) : "\u2014") + "</td>" +
      "</tr>";
    }).join("");

    var doc =
      "<!DOCTYPE html><html><head><meta charset=\"UTF-8\">" +
      "<title>NORTHLINE Student List</title>" +
      "<style>" +
        "@page{ size: A4 landscape; margin: 16mm 14mm; }" +
        "*{ box-sizing:border-box; }" +
        "body{ font-family: -apple-system, 'Segoe UI', Inter, Arial, sans-serif; color:#1a1a1a; margin:0; padding:0; -webkit-print-color-adjust:exact; print-color-adjust:exact; }" +
        ".report-header{ display:flex; align-items:baseline; justify-content:space-between; border-bottom:2px solid #1a1a1a; padding-bottom:10px; margin-bottom:4px; }" +
        ".report-title{ font-size:18px; font-weight:700; letter-spacing:-0.01em; }" +
        ".report-meta{ font-size:11px; color:#555; text-align:right; }" +
        ".report-filters{ font-size:11px; color:#555; margin:6px 0 16px; }" +
        "table{ width:100%; border-collapse:collapse; font-size:11px; }" +
        "thead th{ text-align:left; background:#f0f0f0; border:1px solid #ccc; padding:6px 8px; font-weight:600; }" +
        "tbody td{ border:1px solid #ddd; padding:6px 8px; }" +
        "tbody tr:nth-child(even){ background:#fafafa; }" +
        ".cap{ text-transform:capitalize; }" +
        "tr{ page-break-inside: avoid; }" +
        ".report-footer{ margin-top:14px; font-size:10px; color:#888; text-align:right; }" +
      "</style></head><body>" +
      "<div class=\"report-header\">" +
        "<div class=\"report-title\">NORTHLINE | Student List</div>" +
        "<div class=\"report-meta\">KIPS Counsellor Office<br>Generated " + esc(generatedAt) + "</div>" +
      "</div>" +
      "<div class=\"report-filters\">" + esc(filterSummary) + " &nbsp;|&nbsp; " + filtered.length + " student" + (filtered.length === 1 ? "" : "s") + "</div>" +
      "<table><thead><tr>" +
        "<th>Student</th><th>Father</th><th>Contact</th><th>Roll #</th><th>Matric</th><th>1st Yr</th>" +
        "<th>Pathway</th><th>" + esc(priorityColLabel) + "</th><th>Status</th><th>Submitted</th>" +
      "</tr></thead><tbody>" + rowsHtml + "</tbody></table>" +
      "<div class=\"report-footer\">NORTHLINE &middot; KIPS College</div>" +
      "</body></html>";

    // A hidden iframe instead of window.open() -- prints straight to
    // the OS/browser print dialog without ever showing a visible new
    // tab. Positioned off-screen rather than display:none, since a
    // fully display:none iframe fails to print in some browsers.
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
    // afterprint fires once the dialog is dismissed (printed OR
    // cancelled) in every browser that matters here -- but it's not
    // universally guaranteed, so a fallback timeout also removes the
    // iframe in case it never fires.
    iframe.contentWindow.onafterprint = cleanup;
    setTimeout(cleanup, 15000);

    // Give the iframe's document a beat to finish laying out before
    // the print dialog opens, especially for fonts/table reflow.
    setTimeout(function(){
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    }, 250);
  }


  // Shows whichever preference position priorityN currently points at
  // (1st by default). Resets the map first -- without this, switching
  // from e.g. 1st to 5th priority would leave stale 1st-priority names
  // sitting in the map for any student who didn't set a 5th preference,
  // silently showing the wrong rank's data instead of a blank "—".
  function applyFirstPriorities(r){
    if(r.error){ console.error(r.error); return; }
    firstPriorityByFpId = {};
    (r.data||[]).forEach(function(row){
      var name = row.custom_institute_name || lookups.institutes[row.institute_id] || null;
      if(name) firstPriorityByFpId[row.future_pathway_id] = name;
    });

    var usedNames = Array.from(new Set(Object.values(firstPriorityByFpId))).sort();
    var select = document.getElementById("filter-first-priority");
    select.innerHTML = '<option value="">All</option>' +
      usedNames.map(function(n){ return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join("");

    var label = document.getElementById("fp-priority-label");
    if(label) label.textContent = ordinal(priorityN) + " priority university";
    var colLabel = document.getElementById("fp-priority-col-label");
    if(colLabel) colLabel.textContent = ordinal(priorityN) + " Priority";

    renderTable();
  }

  var autoOpenHandled = false; // guards the ?open=<id> URL param check below from firing on every re-render

  function applySubmissions(r){
    if(r.error){ console.error(r.error); return; }
    submissions = r.data || [];
    renderStatsStrip();
    renderTable();

    // Lets other pages (e.g. student-faculties.html) deep-link
    // straight into a specific student's detail view here, instead
    // of that page needing its own separate copy of renderDetail's
    // ~150 lines. Only fires once per page load.
    if(!autoOpenHandled){
      autoOpenHandled = true;
      var openId = new URLSearchParams(window.location.search).get("open");
      if(openId && submissions.some(function(s){ return s.id === openId; })){
        openDetail(openId);
      }
    }
  }

  // ---------------------------------------------------------
  // Missing event listeners — these functions were defined in
  // the overhaul commit but never wired to the DOM elements.
  // ---------------------------------------------------------

  // Select-all checkbox
  document.getElementById("fp-select-all").addEventListener("change", function(e){
    var checked = e.target.checked;
    document.querySelectorAll("#fp-admin-tbody .fp-row-select").forEach(function(cb){
      cb.checked = checked;
      if(checked) selectedIds.add(cb.dataset.id);
      else selectedIds.delete(cb.dataset.id);
    });
    updateBulkActionsBar();
  });

  // Bulk action dropdown toggle
  document.getElementById("fp-bulk-dropdown-toggle").addEventListener("click", function(e){
    toggleBulkMenu(e);
  });
  document.addEventListener("click", function(e){
    if(!e.target.closest(".fp-bulk-menu-wrapper")) closeBulkMenu();
  });

  // Bulk "Clear data for selected" (dropdown item)
  document.getElementById("fp-bulk-clear").addEventListener("click", function(){
    closeBulkMenu();
    var ids = Array.from(selectedIds);
    if(!ids.length) return;
    var names = ids.map(function(id){
      var sub = submissions.find(function(x){ return x.id === id; });
      return sub ? (titleCase((sub.students && sub.students.student_name) || "") || null) : null;
    }).filter(Boolean);
    var confirmMsg = "Clear data for " + ids.length + " student" + (ids.length === 1 ? "" : "s") + "?\n\n" +
      (names.length ? names.slice(0, 6).join(", ") + (names.length > 6 ? ", and " + (names.length - 6) + " more" : "") + "\n\n" : "") +
      "This resets their forms to draft and clears submitted answers, but keeps their accounts and profile info (name, marks) intact.";
    FP.confirm(confirmMsg).then(function(confirmed){
      if(!confirmed) return;
      setBulkLoading(true, "Clearing\u2026");
      Promise.all(ids.map(function(id){
        return new Promise(function(resolve){
          performReset(id, null, function(ok){
            if(ok){
              var sub = submissions.find(function(x){ return x.id === id; });
              if(sub){ sub.status = "draft"; sub.submitted_at = null; sub.additional_information = null; }
              selectedIds.delete(id);
            }
            resolve();
          });
        });
      })).then(function(){
        setBulkLoading(false);
        FP.toast.success("Cleared data for " + ids.length + " student" + (ids.length === 1 ? "" : "s"));
        renderStatsStrip();
        renderTable();
        updateBulkActionsBar();
      });
    });
  });

  // Bulk "Delete selected" (dropdown item)
  document.getElementById("fp-bulk-delete").addEventListener("click", function(){
    closeBulkMenu();
    var ids = Array.from(selectedIds);
    if(!ids.length) return;
    var allSelected = ids.map(function(id){
      var sub = submissions.find(function(x){ return x.id === id; });
      return sub ? { fpId: id, studentId: sub.student_id, name: titleCase((sub.students && sub.students.student_name) || "") } : null;
    }).filter(Boolean);

    // Own row can't go through counsellor_delete_student() (it
    // deliberately refuses to target auth.uid()) -- drop it from the
    // batch and point to the per-row "Remove my profile" action
    // instead, rather than letting it silently fail inside Promise.all.
    var studentIds = allSelected.filter(function(s){ return s.studentId !== currentUserId; });
    var skippedSelf = allSelected.length !== studentIds.length;
    if(!studentIds.length){
      FP.toast.error("That's your own profile \u2014 use \u201cRemove my profile\u201d on that row instead.");
      return;
    }

    var names = studentIds.map(function(s){ return s.name; }).filter(Boolean);
    var confirmMsg = "Permanently delete " + studentIds.length + " student account" + (studentIds.length === 1 ? "" : "s") + "?\n\n" +
      (names.length ? names.slice(0, 6).join(", ") + (names.length > 6 ? ", and " + (names.length - 6) + " more" : "") + "\n\n" : "") +
      "This removes their names, profiles, and all submitted data from the database completely. This cannot be undone." +
      (skippedSelf ? "\n\n(Your own profile was excluded \u2014 use \u201cRemove my profile\u201d on that row instead.)" : "");
    FP.confirm(confirmMsg).then(function(confirmed){
      if(!confirmed) return;
      setBulkLoading(true, "Deleting\u2026");
      var failures = 0;
      Promise.all(studentIds.map(function(s){
        return new Promise(function(resolve){
          FP.client.rpc("counsellor_delete_student", { p_student_id: s.studentId }).then(function(r){
            if(!r.error){
              submissions = submissions.filter(function(x){ return x.id !== s.fpId; });
              selectedIds.delete(s.fpId);
            } else {
              failures++;
              console.error("Bulk delete failed for", s.name, r.error);
            }
            resolve();
          });
        });
      })).then(function(){
        setBulkLoading(false);
        var succeeded = studentIds.length - failures;
        if(succeeded > 0){
          FP.toast.success("Deleted " + succeeded + " student account" + (succeeded === 1 ? "" : "s"));
        }
        if(failures > 0){
          FP.toast.error(failures + " account" + (failures === 1 ? "" : "s") + " could not be deleted \u2014 see console for details");
        }
        renderStatsStrip();
        renderTable();
        updateBulkActionsBar();
      });
    });
  });

  // Quick-action buttons removed (dropdown covers both actions now)

  // Column sort headers
  document.querySelectorAll(".fp-th-sortable").forEach(function(th){
    th.querySelector(".fp-th-btn").addEventListener("click", function(){
      var col = th.dataset.sort;
      if(sortState.col === col){
        sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
      } else {
        sortState.col = col;
        sortState.dir = "asc";
      }
      paginationState.page = 1;
      renderTable();
    });
  });

  // Filter inputs
  document.getElementById("filter-name").addEventListener("input", function(){ paginationState.page = 1; renderTable(); });
  document.getElementById("filter-pathway").addEventListener("change", function(){ paginationState.page = 1; renderTable(); });
  document.getElementById("filter-status").addEventListener("change", function(){ paginationState.page = 1; renderTable(); });
  document.getElementById("filter-first-priority").addEventListener("change", function(){ paginationState.page = 1; renderTable(); });

  // Steps priorityN forward (1 -> 2 -> ... -> 20 -> 1) or backward
  // (20 -> 19 -> ... -> 1 -> 20). Re-fetches which institute each
  // student has at that position and rebuilds both the filter
  // dropdown (only institutes someone actually has at that exact
  // position show up as options) and the table column.
  function stepPriority(delta){
    priorityN = priorityN + delta;
    if(priorityN > 20) priorityN = 1;
    if(priorityN < 1) priorityN = 20;
    document.getElementById("filter-first-priority").value = ""; // old selection may not exist at the new rank
    var nextBtn = document.getElementById("fp-priority-cycle");
    var prevBtn = document.getElementById("fp-priority-prev");
    if(nextBtn) nextBtn.disabled = true;
    if(prevBtn) prevBtn.disabled = true;
    fetchFirstPriorities().finally(function(){
      if(nextBtn) nextBtn.disabled = false;
      if(prevBtn) prevBtn.disabled = false;
    });
  }

  var cycleBtn = document.getElementById("fp-priority-cycle");
  if(cycleBtn) cycleBtn.addEventListener("click", function(){ stepPriority(1); });

  var prevBtn = document.getElementById("fp-priority-prev");
  if(prevBtn) prevBtn.addEventListener("click", function(){ stepPriority(-1); });

  // ---------------------------------------------------------
  // Action functions (missing from overhaul commit)
  // ---------------------------------------------------------

  function performReset(fpId, triggerBtn, onDone){
    if(triggerBtn) triggerBtn.disabled = true;
    FP.client.rpc("counsellor_reset_submission", { p_future_pathway_id: fpId }).then(function(r){
      if(r.error){
        FP.toast.error("Could not reset: " + r.error.message);
        if(triggerBtn) triggerBtn.disabled = false;
        onDone(false);
        return;
      }
      onDone(true);
    });
  }

  function resetSubmission(fpId, studentName, triggerBtn, onDone){
    var confirmMsg = "Clear " + (studentName || "this student") + "'s form back to an editable draft?\n\n" +
      "This clears their submitted answers but keeps their account and profile info (name, roll number, marks) intact.";
    FP.confirm(confirmMsg).then(function(confirmed){
      if(!confirmed){ onDone(false); return; }
      performReset(fpId, triggerBtn, onDone);
    });
  }

  function deleteStudent(studentId, studentName, triggerBtn, onDone){
    var confirmMsg = "Permanently delete " + (studentName || "this student") + "'s account?\n\n" +
      "This removes their name, profile, and every submitted answer from the database completely \u2014 " +
      "not just this form. This cannot be undone. If you only want to clear their submitted answers " +
      "and let them start over, use \u201cClear data\u201d instead.";
    FP.confirm(confirmMsg).then(function(confirmed){
      if(!confirmed){ onDone(false); return; }
      if(triggerBtn) triggerBtn.disabled = true;
      FP.client.rpc("counsellor_delete_student", { p_student_id: studentId }).then(function(r){
        if(r.error){
          FP.toast.error("Could not delete: " + r.error.message);
          if(triggerBtn) triggerBtn.disabled = false;
          onDone(false);
          return;
        }
        onDone(true);
      });
    });
  }

  function removeOwnStudentProfile(fpId, triggerBtn, onDone){
    var confirmMsg = "Remove your own leftover student profile?\n\n" +
      "This deletes any student name/marks and submitted form tied to your account, " +
      "but keeps your counsellor/admin login intact \u2014 you'll still be able to sign in normally.";
    FP.confirm(confirmMsg).then(function(confirmed){
      if(!confirmed){ onDone(false); return; }
      if(triggerBtn) triggerBtn.disabled = true;
      FP.client.rpc("counsellor_remove_own_student_profile").then(function(r){
        if(r.error){
          FP.toast.error("Could not remove profile: " + r.error.message);
          if(triggerBtn) triggerBtn.disabled = false;
          onDone(false);
          return;
        }
        onDone(true);
      });
    });
  }

  function renderStatsStrip(){
    var el = document.getElementById("fp-stats-strip");
    if(!el) return;
    var submitted = submissions.filter(function(s){ return s.status === "submitted"; }).length;
    var draft = submissions.filter(function(s){ return s.status === "draft"; }).length;
    var engineering = submissions.filter(function(s){ return s.pathway === "engineering"; }).length;
    var medical = submissions.filter(function(s){ return s.pathway === "medical"; }).length;
    var stats = [
      ["TOTAL", submissions.length, ""],
      ["SUBMITTED", submitted, "accent-green"],
      ["DRAFT", draft, "accent-amber"],
      ["ENGINEERING", engineering, "accent-violet"],
      ["MEDICAL", medical, "accent-violet"]
    ];
    el.innerHTML = stats.map(function(s){
      return '<div class="fp-stat ' + s[2] + '"><div class="fp-stat-value">' + s[1] + '</div><div class="fp-stat-label">' + s[0] + '</div></div>';
    }).join("");
  }

  var selectedIds = new Set();
  var sortState = { col: null, dir: "asc" };
  var paginationState = { page: 1, pageSize: 25 };

  function closeBulkMenu(){
    var menu = document.getElementById("fp-bulk-dropdown-menu");
    var toggle = document.getElementById("fp-bulk-dropdown-toggle");
    if(menu) menu.hidden = true;
    if(toggle) toggle.setAttribute("aria-expanded", "false");
  }

  function toggleBulkMenu(e){
    if(e) e.stopPropagation();
    var menu = document.getElementById("fp-bulk-dropdown-menu");
    var toggle = document.getElementById("fp-bulk-dropdown-toggle");
    if(!menu) return;
    var isHidden = menu.hidden;
    menu.hidden = !isHidden;
    if(toggle) toggle.setAttribute("aria-expanded", String(isHidden));
  }

  function setBulkLoading(isLoading, label){
    var btns = document.querySelectorAll(".fp-bulk-actions button");
    btns.forEach(function(b){ b.disabled = isLoading; });
    var countEl = document.getElementById("fp-bulk-count");
    if(countEl && label){
      countEl.textContent = label;
    }
  }

  function updateBulkActionsBar(){
    var bar = document.getElementById("fp-bulk-actions");
    var countEl = document.getElementById("fp-bulk-count");
    if(selectedIds.size === 0){
      bar.hidden = true;
      bar.classList.remove("reveal-in");
      closeBulkMenu();
      return;
    }
    var wasHidden = bar.hidden;
    bar.hidden = false;
    countEl.textContent = selectedIds.size + (selectedIds.size === 1 ? " student" : " students") + " selected";
    if(wasHidden){
      bar.classList.remove("reveal-in");
      void bar.offsetWidth;
      bar.classList.add("reveal-in");
    }
  }

  function getFilteredSubmissions(){
    var nameFilter = (document.getElementById("filter-name").value || "").trim().toLowerCase();
    var pathwayFilter = document.getElementById("filter-pathway").value;
    var statusFilter = document.getElementById("filter-status").value;
    var firstPriorityFilter = document.getElementById("filter-first-priority").value;
    return submissions.filter(function(s){
      var studentName = ((s.students && s.students.student_name) || "").toLowerCase();
      return (!nameFilter || studentName.indexOf(nameFilter) !== -1)
        && (!pathwayFilter || s.pathway === pathwayFilter)
        && (!statusFilter || s.status === statusFilter)
        && (!firstPriorityFilter || firstPriorityByFpId[s.id] === firstPriorityFilter);
    });
  }

  function sortRows(rows){
    if(!sortState.col) return rows;
    return rows.slice().sort(function(a, b){
      var valA, valB;
      if(sortState.col === "name"){
        valA = ((a.students && a.students.student_name) || "").toLowerCase();
        valB = ((b.students && b.students.student_name) || "").toLowerCase();
      } else if(sortState.col === "pathway"){
        valA = (a.pathway || "").toLowerCase();
        valB = (b.pathway || "").toLowerCase();
      } else if(sortState.col === "first_priority"){
        valA = (firstPriorityByFpId[a.id] || "").toLowerCase();
        valB = (firstPriorityByFpId[b.id] || "").toLowerCase();
      } else if(sortState.col === "status"){
        valA = (a.status || "").toLowerCase();
        valB = (b.status || "").toLowerCase();
      } else if(sortState.col === "submitted_at"){
        valA = a.submitted_at ? new Date(a.submitted_at).getTime() : 0;
        valB = b.submitted_at ? new Date(b.submitted_at).getTime() : 0;
      } else {
        valA = a.created_at ? new Date(a.created_at).getTime() : 0;
        valB = b.created_at ? new Date(b.created_at).getTime() : 0;
      }
      if(valA < valB) return sortState.dir === "asc" ? -1 : 1;
      if(valA > valB) return sortState.dir === "asc" ? 1 : -1;
      return 0;
    });
  }

  function renderFilterChips(){
    var chipsContainer = document.getElementById("fp-active-filter-chips");
    if(!chipsContainer) return;
    var name = (document.getElementById("filter-name").value || "").trim();
    var pathway = document.getElementById("filter-pathway").value;
    var status = document.getElementById("filter-status").value;
    var firstPrio = document.getElementById("filter-first-priority").value;

    var chips = [];
    if(name) chips.push({ type: "name", label: 'Search: "' + name + '"' });
    if(pathway) chips.push({ type: "pathway", label: 'Pathway: ' + (pathway === "engineering" ? "Engineering" : "Medical") });
    if(status) chips.push({ type: "status", label: 'Status: ' + status });
    if(firstPrio) chips.push({ type: "first_priority", label: ordinal(priorityN) + " choice: " + firstPrio });

    if(!chips.length){
      chipsContainer.hidden = true;
      chipsContainer.innerHTML = "";
      return;
    }

    chipsContainer.hidden = false;
    chipsContainer.innerHTML = chips.map(function(c){
      return '<span class="fp-chip"><span>' + esc(c.label) + '</span> <button type="button" class="fp-chip-remove" data-chip="' + c.type + '" aria-label="Remove filter">&times;</button></span>';
    }).join("") + '<button type="button" class="fp-chip-clear-all" id="fp-clear-all-chips">Clear filters</button>';

    chipsContainer.querySelectorAll(".fp-chip-remove").forEach(function(btn){
      btn.addEventListener("click", function(){
        var t = btn.dataset.chip;
        if(t === "name") document.getElementById("filter-name").value = "";
        if(t === "pathway") document.getElementById("filter-pathway").value = "";
        if(t === "status") document.getElementById("filter-status").value = "";
        if(t === "first_priority") document.getElementById("filter-first-priority").value = "";
        paginationState.page = 1;
        renderTable();
      });
    });

    var clearAll = document.getElementById("fp-clear-all-chips");
    if(clearAll){
      clearAll.addEventListener("click", function(){
        document.getElementById("filter-name").value = "";
        document.getElementById("filter-pathway").value = "";
        document.getElementById("filter-status").value = "";
        document.getElementById("filter-first-priority").value = "";
        paginationState.page = 1;
        renderTable();
      });
    }
  }

  function renderPagination(totalCount){
    var bar = document.getElementById("fp-pagination-bar");
    if(!bar) return;
    if(totalCount === 0){
      bar.hidden = true;
      return;
    }
    bar.hidden = false;

    var size = paginationState.pageSize === "all" ? totalCount : parseInt(paginationState.pageSize, 10);
    var totalPages = Math.ceil(totalCount / size) || 1;
    if(paginationState.page > totalPages) paginationState.page = totalPages;

    var startIdx = paginationState.pageSize === "all" ? 1 : ((paginationState.page - 1) * size + 1);
    var endIdx = paginationState.pageSize === "all" ? totalCount : Math.min(paginationState.page * size, totalCount);

    bar.innerHTML =
      '<div class="fp-pagination-info">Showing <strong>' + startIdx + '&ndash;' + endIdx + '</strong> of <strong>' + totalCount + '</strong> students</div>' +
      '<div class="fp-pagination-controls">' +
        '<label style="display:inline-flex; align-items:center; gap:6px; font-size:.74rem; font-family:var(--font-mono);">' +
          'Rows:' +
          '<select class="fp-page-size-select" id="fp-page-size-select">' +
            '<option value="25"' + (paginationState.pageSize == 25 ? ' selected' : '') + '>25</option>' +
            '<option value="50"' + (paginationState.pageSize == 50 ? ' selected' : '') + '>50</option>' +
            '<option value="100"' + (paginationState.pageSize == 100 ? ' selected' : '') + '>100</option>' +
            '<option value="all"' + (paginationState.pageSize === 'all' ? ' selected' : '') + '>All</option>' +
          '</select>' +
        '</label>' +
        '<button type="button" class="fp-page-btn" id="fp-page-prev"' + (paginationState.page <= 1 ? ' disabled' : '') + '>&larr; Prev</button>' +
        '<span style="font-family:var(--font-mono); font-size:.74rem; padding: 0 4px;">' + paginationState.page + ' / ' + totalPages + '</span>' +
        '<button type="button" class="fp-page-btn" id="fp-page-next"' + (paginationState.page >= totalPages ? ' disabled' : '') + '>Next &rarr;</button>' +
      '</div>';

    var pageSizeSelect = document.getElementById("fp-page-size-select");
    if(pageSizeSelect){
      pageSizeSelect.addEventListener("change", function(e){
        paginationState.pageSize = e.target.value;
        paginationState.page = 1;
        renderTable();
      });
    }
    var prevBtn = document.getElementById("fp-page-prev");
    if(prevBtn){
      prevBtn.addEventListener("click", function(){
        if(paginationState.page > 1){
          paginationState.page--;
          renderTable();
        }
      });
    }
    var nextBtn = document.getElementById("fp-page-next");
    if(nextBtn){
      nextBtn.addEventListener("click", function(){
        if(paginationState.page < totalPages){
          paginationState.page++;
          renderTable();
        }
      });
    }
  }

  function updateSortHeaders(){
    document.querySelectorAll(".fp-th-sortable").forEach(function(th){
      var col = th.dataset.sort;
      var icon = th.querySelector(".fp-th-sort-icon");
      if(sortState.col === col){
        th.classList.add("is-sorted");
        if(icon) icon.innerHTML = sortState.dir === "asc" ? "&#9650;" : "&#9660;";
      } else {
        th.classList.remove("is-sorted");
        if(icon) icon.innerHTML = "&#8693;";
      }
    });
  }

  function renderTable(){
    renderFilterChips();
    var filtered = getFilteredSubmissions();
    var sorted = sortRows(filtered);
    updateSortHeaders();

    var totalCount = sorted.length;
    var size = paginationState.pageSize === "all" ? totalCount : parseInt(paginationState.pageSize, 10);
    var start = paginationState.pageSize === "all" ? 0 : (paginationState.page - 1) * size;
    var pagedRows = sorted.slice(start, start + size);

    var tbody = document.getElementById("fp-admin-tbody");
    if(totalCount === 0){
      tbody.innerHTML =
        '<tr><td colspan="7">' +
          '<div class="fp-empty-state">' +
            '<div class="fp-empty-icon">&#128269;</div>' +
            '<h3>No students found</h3>' +
            '<p>No submissions match the current filters. Try changing your search query or reset filters.</p>' +
            '<button type="button" class="btn-secondary" id="fp-empty-reset-btn">Reset all filters</button>' +
          '</div>' +
        '</td></tr>';
      var emptyResetBtn = document.getElementById("fp-empty-reset-btn");
      if(emptyResetBtn){
        emptyResetBtn.addEventListener("click", function(){
          document.getElementById("filter-name").value = "";
          document.getElementById("filter-pathway").value = "";
          document.getElementById("filter-status").value = "";
          document.getElementById("filter-first-priority").value = "";
          paginationState.page = 1;
          renderTable();
        });
      }
      renderPagination(0);
      return;
    }

    tbody.innerHTML = pagedRows.map(function(s){
      var name = titleCase((s.students && s.students.student_name) || "") || "(no profile yet)";
      var firstPriority = firstPriorityByFpId[s.id] || "\u2014";
      var checked = selectedIds.has(s.id) ? " checked" : "";
      var isSelf = currentUserId && s.student_id === currentUserId;
      // A counsellor/admin's own account can end up with a leftover
      // students/future_pathways row (tested it themselves, or was a
      // student before being promoted). counsellor_delete_student()
      // deliberately refuses to target auth.uid() -- see its own
      // comment -- so the normal Delete button would just fail with
      // "Cannot delete your own account through this function" for
      // this one row. Swap in the narrow self-cleanup action instead
      // (see counsellor_remove_own_student_profile.sql): removes the
      // leftover student data only, keeps the actual login intact.
      var deleteAction = isSelf
        ? '<button type="button" class="fp-row-action-link fp-row-action-remove-self" data-remove-self-id="' + s.id + '">Remove my profile</button>'
        : '<button type="button" class="fp-row-action-link fp-row-action-delete" data-delete-id="' + s.id + '" data-student-id="' + esc(s.student_id) + '">Delete</button>';
      return '<tr data-id="' + s.id + '">' +
        '<td class="fp-select-td"><label class="fp-select-cell"><input type="checkbox" class="fp-row-select" data-id="' + s.id + '" aria-label="Select ' + esc(name) + '"' + checked + '></label></td>' +
        '<td><strong>' + esc(name) + (isSelf ? ' <span class="fp-hint">(you)</span>' : '') + '</strong></td>' +
        '<td class="fp-cap">' + esc(s.pathway) + '</td>' +
        '<td>' + esc(firstPriority) + '</td>' +
        '<td><span class="fp-badge ' + esc(s.status) + '">' + esc(s.status) + '</span></td>' +
        '<td>' + (s.submitted_at ? new Date(s.submitted_at).toLocaleDateString() : "\u2014") + '</td>' +
        '<td class="fp-row-actions">' +
          '<a href="pathways.html?student=' + esc(s.student_id) + '" class="fp-row-action-link">Edit</a>' +
          '<button type="button" class="fp-row-action-link fp-row-action-clear" data-clear-id="' + s.id + '">Clear data</button>' +
          deleteAction +
        '</td>' +
      '</tr>';
    }).join("");

    document.querySelectorAll("#fp-admin-tbody tr[data-id]").forEach(function(tr){
      tr.addEventListener("click", function(e){
        if(e.target.closest(".fp-row-actions") || e.target.closest(".fp-select-td")) return;
        openDetail(tr.dataset.id);
      });
    });

    document.querySelectorAll("#fp-admin-tbody .fp-row-select").forEach(function(cb){
      cb.addEventListener("click", function(e){ e.stopPropagation(); });
      cb.addEventListener("change", function(){
        if(cb.checked) selectedIds.add(cb.dataset.id);
        else selectedIds.delete(cb.dataset.id);
        var selectAll = document.getElementById("fp-select-all");
        var visibleBoxes = document.querySelectorAll("#fp-admin-tbody .fp-row-select");
        selectAll.checked = visibleBoxes.length > 0 && Array.from(visibleBoxes).every(function(b){ return b.checked; });
        updateBulkActionsBar();
      });
    });

    // "Clear data" -- resets to an editable draft, keeps the account.
    document.querySelectorAll("#fp-admin-tbody .fp-row-action-clear").forEach(function(btn){
      btn.addEventListener("click", function(e){
        e.stopPropagation();
        var fpId = btn.dataset.clearId;
        var sub = submissions.find(function(x){ return x.id === fpId; });
        if(!sub) return;
        var studentName = titleCase((sub.students && sub.students.student_name) || "");
        resetSubmission(fpId, studentName, btn, function(ok){
          if(!ok) return;
          sub.status = "draft";
          sub.submitted_at = null;
          sub.additional_information = null;
          selectedIds.delete(fpId);
          FP.toast.success("Reset " + (studentName || "student") + "'s form to draft");
          renderStatsStrip();
          renderTable();
          updateBulkActionsBar();
        });
      });
    });

    // "Delete" -- REAL, PERMANENT deletion. Removes student account entirely.
    document.querySelectorAll("#fp-admin-tbody .fp-row-action-delete").forEach(function(btn){
      btn.addEventListener("click", function(e){
        e.stopPropagation();
        var fpId = btn.dataset.deleteId;
        var studentId = btn.dataset.studentId;
        var sub = submissions.find(function(x){ return x.id === fpId; });
        if(!sub) return;
        var studentName = titleCase((sub.students && sub.students.student_name) || "");
        deleteStudent(studentId, studentName, btn, function(ok){
          if(!ok) return;
          submissions = submissions.filter(function(x){ return x.id !== fpId; });
          selectedIds.delete(fpId);
          FP.toast.success("Deleted " + (studentName || "student") + "'s account");
          renderStatsStrip();
          renderTable();
          updateBulkActionsBar();
        });
      });
    });

    // "Remove my profile" -- self-only cleanup for a counsellor/admin
    // whose own account also has a leftover students/future_pathways
    // row. See counsellor_remove_own_student_profile.sql.
    document.querySelectorAll("#fp-admin-tbody .fp-row-action-remove-self").forEach(function(btn){
      btn.addEventListener("click", function(e){
        e.stopPropagation();
        var fpId = btn.dataset.removeSelfId;
        removeOwnStudentProfile(fpId, btn, function(ok){
          if(!ok) return;
          submissions = submissions.filter(function(x){ return x.id !== fpId; });
          selectedIds.delete(fpId);
          FP.toast.success("Removed your student profile");
          renderStatsStrip();
          renderTable();
          updateBulkActionsBar();
        });
      });
    });

    var selectAllBox = document.getElementById("fp-select-all");
    var visibleBoxesNow = document.querySelectorAll("#fp-admin-tbody .fp-row-select");
    selectAllBox.checked = visibleBoxesNow.length > 0 && Array.from(visibleBoxesNow).every(function(b){ return b.checked; });

    renderPagination(totalCount);
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

  // ---------------------------------------------------------
  // Detail view
  // ---------------------------------------------------------
  function openDetail(id){
    var sub = submissions.find(function(s){ return s.id === id; });
    if(!sub) return;

    document.getElementById("fp-admin-list-view").hidden = true;
    var detail = document.getElementById("fp-admin-detail-view");
    detail.hidden = false;
    detail.innerHTML = '<div class="fp-card"><p>Loading\u2026</p></div>';

    Promise.all([
      FP.client.from("student_institute_preferences").select("*").eq("future_pathway_id", id),
      FP.client.from("student_faculty_preferences").select("*").eq("future_pathway_id", id),
      FP.client.from("student_program_preferences").select("*").eq("future_pathway_id", id),
      FP.client.from("office_evaluations").select("*").eq("future_pathway_id", id).maybeSingle()
    ]).then(function(r){
      renderDetail(sub, r[0].data||[], r[1].data||[], r[2].data||[], r[3].data);
    });
  }

  // Four independently-collapsible sections
  function groupedAccordion(rows, nameLookup, idPrefix){
    var byGroup = {};
    rows.forEach(function(r){
      byGroup[r.preference_group] = byGroup[r.preference_group] || [];
      byGroup[r.preference_group][r.rank-1] = r.custom_institute_name || r.custom_faculty_name ||
        nameLookup[r.institute_id || r.faculty_id] || null;
    });

    var groupNums = Object.keys(byGroup).sort();
    if(!groupNums.length){
      return '<p class="fp-accordion-empty">No preferences submitted yet.</p>';
    }

    return '<div class="fp-accordion">' + groupNums.map(function(g){
      var picks = byGroup[g];
      var panelId = idPrefix + "-group-" + g;
      var gi = Number(g) - 1; // groups are 1-indexed in the data; gi is the 0-indexed position used for global numbering
      var rangeStart = gi * 5 + 1, rangeEnd = gi * 5 + 5;
      // <li value> is the global flattened position (6, 7, 8...), not
      // the 1-5 position within this group -- otherwise every group's
      // list looks identical ("1, 2, 3, 4, 5") regardless of whether
      // it's actually the student's 1st or 16th choice.
      var listItems = picks.map(function(name, i){
        return name ? '<li value="' + (gi * 5 + i + 1) + '">' + esc(name) + '</li>' : "";
      }).filter(Boolean).join("");
      var body = listItems ? '<ol class="fp-accordion-list">' + listItems + '</ol>' : '<p class="fp-accordion-empty">No picks in this group yet.</p>';

      return (
        '<div class="fp-accordion-item">' +
          '<button type="button" class="fp-accordion-header" aria-expanded="false" data-accordion-target="' + panelId + '">' +
            '<span>Group ' + esc(g) + ' <span class="fp-hint">(' + rangeStart + '\u2013' + rangeEnd + ')</span></span>' +
            '<span class="fp-accordion-chevron">&#9662;</span>' +
          '</button>' +
          '<div class="fp-accordion-panel-wrapper" id="' + panelId + '">' +
            '<div class="fp-accordion-panel">' + body + '</div>' +
          '</div>' +
        '</div>'
      );
    }).join("") + '</div>';
  }

  function renderDetail(sub, instRows, facRows, progRows, evalRow){
    var p = sub.students || {};
    var careerNames = progRows.map(function(r){ return r.custom_program_name || lookups.careers[r.program_id] || lookups.faculties[r.program_id] || null; }).filter(Boolean);
    evalRow = evalRow || {};

    var profileHtml = ["student_name","father_name","father_profession","contact","discipline","section","roll_number","matric_marks","first_year_marks"]
      .map(function(k){ return '<div class="fp-review-row"><span>' + k.replace(/_/g," ") + '</span><span>' + esc(p[k]) + '</span></div>'; }).join("");

    var recFields = "";
    for(var i=1;i<=12;i++){
      recFields += '<label>Recommendation ' + i + '<input type="text" data-rec="' + i + '" value="' + esc(evalRow["recommendation_"+i] || "") + '"></label>';
    }

    document.getElementById("fp-admin-detail-view").innerHTML =
      '<button type="button" class="btn-secondary" id="fp-back-to-list" style="margin-bottom:16px;">&larr; Back to list</button>' +
      '<div class="fp-card">' +
        '<div style="display:flex; align-items:baseline; justify-content:space-between; flex-wrap:wrap; gap:10px;">' +
          '<h2 class="fp-step-title" style="margin-bottom:0;">' + esc(p.student_name || "Student") + '</h2>' +
          '<div style="display:flex; gap:8px;">' +
            '<a href="pathways.html?student=' + esc(sub.student_id) + '" class="nav-link">Edit this form</a>' +
            '<button type="button" class="nav-link" id="fp-ask-assistant">Ask assistant</button>' +
            '<button type="button" class="nav-link" id="fp-print-student">&#128438; Print</button>' +
            '<button type="button" class="nav-link" id="fp-reset-submission" style="color:var(--amber);">Clear student\'s data</button>' +
            '<button type="button" class="nav-link" id="fp-delete-student" style="color:var(--red);">Delete</button>' +
          '</div>' +
        '</div>' +
        '<p class="fp-step-desc">' + esc(sub.pathway) + ' | <span class="fp-badge ' + esc(sub.status) + '">' + esc(sub.status) + '</span></p>' +
        '<div class="fp-review-section"><h4>Student information</h4>' + profileHtml + '</div>' +
        '<div class="fp-review-section"><h4>Programs &amp; careers</h4><div class="fp-review-row"><span>Selected</span><span>' + esc(careerNames.join(", ") || "\u2014") + '</span></div></div>' +
        '<div class="fp-review-section"><h4>Institute preferences</h4>' + groupedAccordion(instRows, lookups.institutes, "inst") + '</div>' +
        '<div class="fp-review-section"><h4>Faculty preferences</h4>' + groupedAccordion(facRows, lookups.faculties, "fac") + '</div>' +
        '<div class="fp-review-section"><h4>Additional information</h4><p>' + esc(sub.additional_information || "\u2014") + '</p></div>' +
      '</div>' +
      '<div class="fp-card">' +
        '<h2 class="fp-step-title">Office evaluation</h2>' +
        '<div class="fp-form">' +
          '<div class="fp-grid-2">' + recFields + '</div>' +
          '<div class="fp-grid-2">' +
            '<label>Counsellor name<input type="text" id="eval-counsellor-name" value="' + esc(evalRow.counsellor_name||"") + '"></label>' +
            '<label>Counsellor signature<input type="text" id="eval-counsellor-signature" value="' + esc(evalRow.counsellor_signature||"") + '"></label>' +
          '</div>' +
          '<label>Principal<input type="text" id="eval-principal" value="' + esc(evalRow.principal||"") + '"></label>' +
          '<label>Remarks<textarea id="eval-remarks" rows="4" style="width:100%; font-family:var(--font-body); padding:10px 12px; border:1px solid var(--line-strong); border-radius:var(--radius-sm);">' + esc(evalRow.remarks||"") + '</textarea></label>' +
          '<button type="button" class="btn-primary" id="eval-save">Save evaluation</button>' +
        '</div>' +
      '</div>';

    document.getElementById("fp-back-to-list").addEventListener("click", function(){
      document.getElementById("fp-admin-detail-view").hidden = true;
      document.getElementById("fp-admin-list-view").hidden = false;
    });

    var askBtn = document.getElementById("fp-ask-assistant");
    if(askBtn){
      askBtn.addEventListener("click", function(){
        if(window.FP && FP.chatAssistant){
          FP.chatAssistant.openForStudent(sub.student_id, titleCase(p.student_name || ""));
        }
      });
    }

    var printBtn = document.getElementById("fp-print-student");
    if(printBtn){
      printBtn.addEventListener("click", function(){
        printStudentForm(sub, instRows, facRows, careerNames, evalRow);
      });
    }

    document.querySelectorAll(".fp-accordion-header").forEach(function(btn){
      btn.addEventListener("click", function(){
        var panel = document.getElementById(btn.dataset.accordionTarget);
        var isOpen = btn.getAttribute("aria-expanded") === "true";
        btn.setAttribute("aria-expanded", isOpen ? "false" : "true");
        panel.classList.toggle("is-open", !isOpen);
      });
    });

    var resetBtn = document.getElementById("fp-reset-submission");
    if(resetBtn){
      resetBtn.addEventListener("click", function(){
        resetSubmission(sub.id, p.student_name, resetBtn, function(ok){
          if(!ok) return;
          sub.status = "draft";
          sub.submitted_at = null;
          sub.additional_information = null;
          FP.toast.success("Reset " + (p.student_name || "student") + "'s form to draft");
          renderStatsStrip();
          openDetail(sub.id);
        });
      });
    }

    var deleteBtn = document.getElementById("fp-delete-student");
    if(deleteBtn){
      deleteBtn.addEventListener("click", function(){
        deleteStudent(sub.student_id, p.student_name, deleteBtn, function(ok){
          if(!ok) return;
          submissions = submissions.filter(function(x){ return x.id !== sub.id; });
          document.getElementById("fp-admin-detail-view").hidden = true;
          document.getElementById("fp-admin-list-view").hidden = false;
          FP.toast.success("Deleted " + (p.student_name || "student") + "'s account");
          renderStatsStrip();
          renderTable();
          updateBulkActionsBar();
        });
      });
    }

    document.getElementById("eval-save").addEventListener("click", function(){
      var saveBtn = document.getElementById("eval-save");
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving\u2026";
      var record = { future_pathway_id: sub.id };
      for(var i=1;i<=12;i++){ record["recommendation_"+i] = document.querySelector('[data-rec="'+i+'"]').value; }
      record.counsellor_name = document.getElementById("eval-counsellor-name").value;
      record.counsellor_signature = document.getElementById("eval-counsellor-signature").value;
      record.principal = document.getElementById("eval-principal").value;
      record.remarks = document.getElementById("eval-remarks").value;

      FP.client.from("office_evaluations").upsert([record]).then(function(r){
        saveBtn.disabled = false;
        saveBtn.textContent = "Save evaluation";
        if(r.error){
          FP.toast.error("Could not save: " + r.error.message);
          return;
        }
        FP.toast.success("Office evaluation saved successfully");
      });
    });
  }

  // Flattens grouped preference rows (preference_group + rank) into a
  // single list ordered by global position (1-20), same convention
  // used throughout the site -- Group 2's 1st slot is position 6, etc.
  function flattenPrefsForPrint(rows, nameLookup){
    return rows
      .map(function(r){
        var pos = (r.preference_group - 1) * 5 + r.rank;
        var name = r.custom_institute_name || r.custom_faculty_name || nameLookup[r.institute_id || r.faculty_id] || null;
        return name ? { pos: pos, name: name } : null;
      })
      .filter(Boolean)
      .sort(function(a, b){ return a.pos - b.pos; });
  }

  function printStudentForm(sub, instRows, facRows, careerNames, evalRow){
    var p = sub.students || {};
    evalRow = evalRow || {};
    var name = titleCase(p.student_name || "Student");

    var instList = flattenPrefsForPrint(instRows, lookups.institutes);
    var facList = flattenPrefsForPrint(facRows, lookups.faculties);
    var recommendations = [];
    for(var i=1;i<=12;i++){
      if(evalRow["recommendation_"+i]) recommendations.push(evalRow["recommendation_"+i]);
    }

    function rowHtml(label, value){
      return "<tr><td class=\"label\">" + esc(label) + "</td><td>" + esc(value || "\u2014") + "</td></tr>";
    }
    function prefListHtml(list){
      if(!list.length) return "<p class=\"empty\">No preferences submitted yet.</p>";
      return "<ol class=\"pref-list\">" + list.map(function(item){
        return "<li value=\"" + item.pos + "\">" + esc(item.name) + "</li>";
      }).join("") + "</ol>";
    }

    var generatedAt = new Date().toLocaleString(undefined, {
      year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit"
    });

    var doc =
      "<!DOCTYPE html><html><head><meta charset=\"UTF-8\">" +
      "<title>" + esc(name) + " | NORTHLINE Form</title>" +
      "<style>" +
        "@page{ size: A4; margin: 16mm; }" +
        "*{ box-sizing:border-box; }" +
        "body{ font-family: -apple-system, 'Segoe UI', Inter, Arial, sans-serif; color:#1a1a1a; margin:0; padding:0; -webkit-print-color-adjust:exact; print-color-adjust:exact; }" +
        ".report-header{ display:flex; align-items:baseline; justify-content:space-between; border-bottom:2px solid #1a1a1a; padding-bottom:10px; margin-bottom:16px; }" +
        ".report-title{ font-size:20px; font-weight:700; letter-spacing:-0.01em; }" +
        ".report-meta{ font-size:11px; color:#555; text-align:right; }" +
        "h2{ font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:#444; border-bottom:1px solid #ddd; padding-bottom:4px; margin:20px 0 8px; }" +
        "h2:first-of-type{ margin-top:0; }" +
        "table{ width:100%; border-collapse:collapse; font-size:12px; }" +
        "td{ padding:5px 8px; border-bottom:1px solid #eee; vertical-align:top; }" +
        "td.label{ width:36%; color:#666; font-weight:600; }" +
        ".two-col{ display:grid; grid-template-columns:1fr 1fr; gap:0 24px; }" +
        ".pref-list{ margin:0; padding-left:22px; font-size:12px; columns:2; column-gap:24px; }" +
        ".pref-list li{ break-inside: avoid; padding:2px 0; }" +
        ".empty{ font-size:12px; color:#888; font-style:italic; margin:4px 0; }" +
        "ul.recs{ margin:4px 0; padding-left:18px; font-size:12px; }" +
        "ul.recs li{ padding:2px 0; }" +
        ".report-footer{ margin-top:20px; font-size:10px; color:#888; text-align:right; }" +
        "section{ page-break-inside: avoid; }" +
      "</style></head><body>" +
      "<div class=\"report-header\">" +
        "<div class=\"report-title\">" + esc(name) + "</div>" +
        "<div class=\"report-meta\">NORTHLINE Form &middot; KIPS College<br>Generated " + esc(generatedAt) + "</div>" +
      "</div>" +

      "<section><h2>Student Information</h2><table>" +
        rowHtml("Full name", titleCase(p.student_name)) +
        rowHtml("Father's name", titleCase(p.father_name)) +
        rowHtml("Father's profession", p.father_profession) +
        rowHtml("Contact", p.contact) +
        rowHtml("Discipline", p.discipline) +
        rowHtml("Section", p.section) +
        rowHtml("Roll number", p.roll_number) +
        rowHtml("Matric marks", p.matric_marks != null ? p.matric_marks : null) +
        rowHtml("First year marks", p.first_year_marks != null ? p.first_year_marks : null) +
        rowHtml("Pathway", sub.pathway) +
        rowHtml("Status", sub.status) +
        rowHtml("Submitted", sub.submitted_at ? new Date(sub.submitted_at).toLocaleString() : null) +
      "</table></section>" +

      "<section><h2>Programs &amp; Careers</h2><p style=\"font-size:12px; margin:4px 0;\">" + esc(careerNames.join(", ") || "\u2014") + "</p></section>" +

      "<section><h2>Institute Preferences (1st\u201320th)</h2>" + prefListHtml(instList) + "</section>" +

      "<section><h2>Faculty Preferences (1st\u201320th)</h2>" + prefListHtml(facList) + "</section>" +

      "<section><h2>Additional Information</h2><p style=\"font-size:12px; margin:4px 0;\">" + esc(sub.additional_information || "\u2014") + "</p></section>" +

      (recommendations.length || evalRow.remarks ?
        "<section><h2>Office Evaluation</h2>" +
        (recommendations.length ? "<ul class=\"recs\">" + recommendations.map(function(r){ return "<li>" + esc(r) + "</li>"; }).join("") + "</ul>" : "") +
        (evalRow.remarks ? "<p style=\"font-size:12px;\"><strong>Remarks:</strong> " + esc(evalRow.remarks) + "</p>" : "") +
        (evalRow.counsellor_name ? "<p style=\"font-size:12px;\"><strong>Counsellor:</strong> " + esc(evalRow.counsellor_name) + "</p>" : "") +
        (evalRow.principal ? "<p style=\"font-size:12px;\"><strong>Principal:</strong> " + esc(evalRow.principal) + "</p>" : "") +
        "</section>"
        : "") +

      "<div class=\"report-footer\">NORTHLINE &middot; KIPS College</div>" +
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
  }
})();
