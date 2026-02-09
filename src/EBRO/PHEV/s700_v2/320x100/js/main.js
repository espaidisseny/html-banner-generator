const tl = gsap.timeline({ paused: true });

const width = 320;
const height = 100;


tl.play();


gsap.set("#fondo1", { autoAlpha: 1 });
gsap.set("#cta1a, #cta1b, #cta2a, #cta2b", { autoAlpha: 0 });


tl.from("#hl1", {
  duration: 0.75,
  autoAlpha: 0,
  ease: "sine.inOut"
})
.from("#subhl1", {
  duration: 0.5,
  autoAlpha: 0,
  ease: "sine.inOut"
})
.from("#subhl2", {
  duration: 0.5,
  autoAlpha: 0,
  y:10,
  ease: "sine.inOut"
})
.from("#precio", {
  duration: 0.5,
  autoAlpha: 0,
  ease: "sine.inOut"
})
.to(("#subhl1, #subhl2, #precio"), {
  duration: 0.5,
  autoAlpha: 0,
  ease: "sine.inOut"
}, "+5")
.from("#bg2", {
  duration: 0.5,
  autoAlpha: 0,
  ease: "sine.inOut"
}, "+5")
.from("#subhl3", {
  duration: 0.5,
  autoAlpha: 0,
  ease: "sine.inOut"
});

tl.play();