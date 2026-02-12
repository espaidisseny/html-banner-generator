'use strict';

var tl = new TimelineMax({ paused: true });

var moveTime = 1.0;
var fadeTime = 0.5;
var stageWidth = 980;
var stageHeight = 180;
var defaultEase = Sine.easeInOut;


tl.add([
  TweenMax.from("#subhl1", fadeTime, { autoAlpha: 0, ease: defaultEase }),
], '+=0.3');

tl.add([
  TweenMax.from("#subhl2", fadeTime, { autoAlpha: 0, ease: defaultEase, y: 10 }),
  TweenMax.from("#precio", fadeTime, { autoAlpha: 0, y: 10, ease: defaultEase, delay: 0.5 }),
], '+=0.3');

tl.add([
  TweenMax.to("#subhl2, #subhl1", fadeTime, { autoAlpha: 0, ease: defaultEase }),
  TweenMax.to("#precio", fadeTime, { autoAlpha: 0, ease: defaultEase }),
], '+=3');

tl.add([
  TweenMax.from("#fondo2", fadeTime, { autoAlpha: 0, ease: defaultEase }),
  TweenMax.from("#subhl3", fadeTime, { autoAlpha: 0, ease: defaultEase }),
], '+=0.3');

tl.add([
  TweenMax.from("#cta1a", fadeTime, { ease: defaultEase }),
], '+=3');

var MAX_DURATION = 60;
var loops = Math.floor(MAX_DURATION / tl.duration()) - 1;

// Safety check
loops = Math.max(0, loops);

tl.repeat(loops);


function startAd() {
  TweenMax.set('#cover', { autoAlpha: 0 });
  tl.restart();
}

window.onload = function () {
  startAd();
  var cta1 = document.getElementById("cta1");
  var cta2 = document.getElementById("cta2");

  if (cta1) {
    cta1.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      window.open(window.clickTag, "_blank");
    });
  }

  if (cta2) {
    cta2.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      window.open(window.clickTag2, "_blank");
    });
  }
};

(function () {
  var legalClick = document.getElementById('legalClick');
  var legalCopy = document.getElementById('legalCopy');

  if (!legalClick || !legalCopy) return;

  // Toggle legal copy on click
  legalClick.addEventListener('click', function (e) {
    e.stopPropagation();
    legalCopy.classList.toggle('is-visible');
  });

  // Close legal copy when clicking anywhere else
  document.addEventListener('click', function () {
    legalCopy.classList.remove('is-visible');
  });
})();


