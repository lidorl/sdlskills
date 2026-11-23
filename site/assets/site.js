(function(){
  var root=document.documentElement, KEY='sdlskills-theme';
  try{var s=localStorage.getItem(KEY); if(s){root.setAttribute('data-theme',s);}}catch(e){}
  var t=document.getElementById('theme');
  t&&t.addEventListener('click',function(){
    var cur=root.getAttribute('data-theme'), sysDark=window.matchMedia('(prefers-color-scheme: dark)').matches;
    var next = cur==='dark' ? 'light' : cur==='light' ? 'dark' : (sysDark ? 'light' : 'dark');
    root.setAttribute('data-theme',next);
    try{localStorage.setItem(KEY,next);}catch(e){}
  });
  document.querySelectorAll('.copy-btn').forEach(function(c){
    c.addEventListener('click',function(){
      var txt=c.getAttribute('data-copy')||'';
      if(navigator.clipboard){navigator.clipboard.writeText(txt).then(function(){
        var o=c.textContent; c.textContent='Copied'; setTimeout(function(){c.textContent=o;},1500);
      });}
    });
  });
})();
