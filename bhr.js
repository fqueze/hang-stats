var gdata;
var ghangs;

const kMaxRows = 50;

// The values are the down sampling rates for the various hang sizes.
const hangFiles = {
  "128_512": 0.02,
  "512_2048": 0.1,
  "2048_65536": 0.5,
};

function showProgressMessage(text) {
  let message = document.createElement("p");
  message.textContent = text
  let div = document.getElementById("progress");
  div.appendChild(message);
  return message;
}

function updateProgressMessage(message, text) {
  message.textContent = text;
  return new Promise(resolve => window.requestAnimationFrame(() => {
    setTimeout(resolve, 0);
  }));
}

var gdate, filterString;
function setDate(date) {
  if (gdate)
    return;
  gdate = date;
  document.getElementById("buildid").textContent = `from build ${date}`;
  updateTitle();
}

function updateTitle() {
  let title = ["BHR"];
  if (gdate)
    title.push(gdate);
  if (filterString)
    title.push(filterString);
  document.title = title.join(" - ");
}

function getStackForHang(hang) {
  let stack = [];//39662 38366
//  let shouldRemovePrefix = true;
  for (let {funcName, libName} of hang.frames) {
/*    if (shouldRemovePrefix &&
        ["xul", "XUL", "libxul.so",
         "mozglue", "libmozglue.so"].includes(libName)) {
      shouldRemovePrefix = false;
      if (stack.length > 1)
        stack.splice(0, stack.length - 1);
    }*/
    if (funcName.startsWith("NS_ProcessNextEvent(nsIThread"))
      break;
    stack.push(funcName + " " + libName);
  }
  return stack.join("\n");
}

async function fetchHangs(size) {
  let file = `hang_profile_${size}.json`;
  let message = showProgressMessage(`Fetching ${file}...`);
  let url = `https://analysis-output.telemetry.mozilla.org/bhr/data/hang_aggregates/${file}`;
  let response = await fetch(url);
  await updateProgressMessage(message, `Parsing ${file}...`);
  let data = await response.json();
  await updateProgressMessage(message, `Processing ${file}...`);
  gdata = data;
  let thread;
  for (thread of data.threads)
    if (thread.name == "Gecko" && thread.processType == "default")
      break;
  let day = thread.dates[0];
  let date = day.date;
  setDate(date);
  let usageHours = data.usageHoursByDate[date] / hangFiles[size];

  let hangs = [];
  let hangCount = day.sampleHangMs.length;
  for (let id = 0; id < hangCount; ++id) {
    let frames = [];
    let stack = thread.sampleTable.stack[id];
    let shouldRemovePrefix = true;

    while (stack) {
      let func = thread.stackTable.func[stack];
      let funcName = thread.stringArray[thread.funcTable.name[func]];
      // Stacks with nested event loops are confusing, stop walking the stack
      // as soon as we reach the event queue.
      if (funcName.startsWith("NS_ProcessNextEvent(nsIThread"))
        break;
      let libName = thread.libs[thread.funcTable.lib[func]].name;

      // Leave only one non-Mozilla frame at the top of the stack.
      if (shouldRemovePrefix &&
          ["xul", "XUL", "libxul.so", "nss3", "libnss3.dylib",
           "mozglue", "libmozglue.so"].includes(libName) &&
          !funcName.includes("::InterposedNt")) {
        shouldRemovePrefix = false;
        if (frames.length > 1)
          frames.splice(0, frames.length - 1);
      }

      function isJSFuncName(n) {
        return n.includes(".js") || n.includes(".xul") || n.startsWith("self-hosted:");
      }
      if (!libName && isJSFuncName(funcName) && frames.length) {
        // We are on a JS frame, trim all the previous frames that are internal
        // to the JS engine.
        let i = frames.length - 1;
        const kJSInternalPrefixes = [
          "js::", "JS::",
          "static bool InternalCall",
          "static bool Interpret",
          "static bool js::",
          "bool js::",
          "static bool SetExistingProperty",
          "(unresolved)",
        ];
        while (i && kJSInternalPrefixes.some(p => frames[i].funcName.startsWith(p)))
          --i;
        if (frames[i]) {
          let f = frames[i];
          if ((!f.libName && isJSFuncName(f.funcName)) ||
              f.funcName.startsWith("static bool XPC_WN_"))
            frames.splice(i + 1);
        }

        if (frames.length > 3 &&
            ["XPTC__InvokebyIndex", "NS_InvokeByIndex"].includes(frames[frames.length - 3].funcName) &&
            frames[frames.length - 2].funcName.startsWith("XPCWrappedNative::CallMethod(") &&
            frames[frames.length - 1].funcName.startsWith("static bool XPC_WN_"))
          frames.splice(frames.length - 3);
      }
      
      frames.push({funcName, libName});
      stack = thread.stackTable.prefix[stack];
    }
    hangs.push({duration: Math.round(day.sampleHangMs[id] * usageHours),
                count: Math.round(day.sampleHangCount[id] * usageHours),
                frames});
  }

  message.remove();
  return hangs;
}

function formatTime(time) {
  if (time > 1000)
    return Math.round(time / 1000);
  return time / 1000;
}

function displayHangs(hangs, filterString) {
  if (filterString) {
    hangs = hangs.filter(h => h.frames.some(f => f.funcName.includes(filterString) ||
                                                 f.libName.includes(filterString)));
  }
  let tbody = document.getElementById("tbody");
  while (tbody.firstChild)
    tbody.firstChild.remove();

  let count = 0;
  let totalCount = 0, totalTime = 0;
  for (let hang of hangs) {
    let tr = document.createElement("tr");

    let td = document.createElement("td");
    td.textContent = ++count;
    tr.appendChild(td);

    td = document.createElement("td");
    td.textContent = formatTime(hang.duration).toLocaleString();
    if (hang.duration > 3600000)
      td.title = `${(Math.round(hang.duration / 360000) / 10).toLocaleString()}h`;
    tr.appendChild(td);
    totalTime += hang.duration;

    td = document.createElement("td");
    td.textContent = hang.count.toLocaleString();
    tr.appendChild(td);
    totalCount += hang.count;

    td = document.createElement("td");
    td.textContent = `${hang.frames[0].funcName} ${hang.frames[0].libName}`;
    td.title = getStackForHang(hang);
    tr.appendChild(td);

    tbody.appendChild(tr);

    if (count == kMaxRows) {
      for (let i = count; i < hangs.length; ++i) {
        totalTime += hangs[i].duration;
        totalCount += hangs[i].count;
      }

      tr = document.createElement("tr");
      tr.id = "footer";

      td = document.createElement("td");
      td.textContent = "Total";
      tr.appendChild(td);
      
      td = document.createElement("td");
      td.textContent = formatTime(totalTime).toLocaleString();
      if (totalTime > 3600000)
        td.title = `${(Math.round(totalTime / 360000) / 10).toLocaleString()}h`;
      tr.appendChild(td);

      td = document.createElement("td");
      td.textContent = totalCount.toLocaleString();
      tr.appendChild(td);

      td = document.createElement("td");
      td.textContent = `And ${hangs.length - count} other stacks...`;

      tr.appendChild(td);
      tbody.appendChild(tr);
      break;
    }
  }
  if (!count) {
    let tr = document.createElement("tr");

    let td = document.createElement("td");
    td.textContent = `No hang matching filter`;
    td.setAttribute("colspan", "4");

    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

window.onload = async function() {
  filterString = new URLSearchParams(document.location.hash.slice(1)).get("filter");
  let filterInput = document.getElementById("filter");
  if (filterString)
    filterInput.value = filterString;

  let allHangs = await Promise.all(Object.keys(hangFiles).map(fetchHangs));
  showProgressMessage("Merging and sorting...");
  await new Promise(resolve => window.requestAnimationFrame(() => {
    setTimeout(resolve, 0);
  }));
  
  ghangs = [];
  let hangsMap = new Map();
  for (let hangsArray of allHangs) {
    for (let hang of hangsArray) {
      let stack = getStackForHang(hang);
      if (hangsMap.has(stack)) {
        let existingHang = hangsMap.get(stack);
        existingHang.duration += hang.duration;
        existingHang.count += hang.count;
        continue;
      }
      ghangs.push(hang);
      hangsMap.set(stack, hang);
    }
  }
  
  ghangs.sort((a, b) => b.duration - a.duration);
  displayHangs(ghangs, filterString);

  document.getElementById("progress").remove();

  filterInput.addEventListener("input", event => {
    let urlHash = new URLSearchParams(document.location.hash.slice(1));
    filterString = event.target.value;
    urlHash.set("filter", filterString);
    document.location.hash = urlHash.toString();
    displayHangs(ghangs, filterString);
    updateTitle();
  });
}
