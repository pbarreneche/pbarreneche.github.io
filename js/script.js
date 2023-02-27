/* ----------------------------------------Disenio Web---------------------------------------- */

/* al pasar el mouse */
document.getElementById("DW1").onmouseover = function () { mouseOverDW1() };
document.getElementById("DW2").onmouseover = function () { mouseOverDW1() };


function mouseOverDW1() {
  document.getElementById("DW3").style.width = "93%";

}


/* al sacar el mouse */
document.getElementById("DW1").onmouseout = function () { mouseOutDW1() };
document.getElementById("DW2").onmouseout = function () { mouseOutDW1() };

function mouseOutDW1() {
  document.getElementById("DW3").style.width = "0%";
}

/* ----------------------------------------Disenio Grafico---------------------------------------- */


/* al pasar el mouse */
document.getElementById("DG1").onmouseover = function () { mouseOverDG1() };
document.getElementById("DG2").onmouseover = function () { mouseOverDG1() };


function mouseOverDG1() {
  document.getElementById("DG3").style.width = "100%";

}


/* al sacar el mouse */
document.getElementById("DG1").onmouseout = function () { mouseOutDG1() };
document.getElementById("DG2").onmouseout = function () { mouseOutDG1() };

function mouseOutDG1() {
  document.getElementById("DG3").style.width = "0%";
}

/* ----------------------------------------Disenio Ui---------------------------------------- */

/* al pasar el mouse */
document.getElementById("DUi1").onmouseover = function () { mouseOverDUi1() };
document.getElementById("DUi2").onmouseover = function () { mouseOverDUi1() };


function mouseOverDUi1() {
  document.getElementById("DUi3").style.width = "79%";

}


/* al sacar el mouse */
document.getElementById("DUi1").onmouseout = function () { mouseOutDUi1() };
document.getElementById("DUi2").onmouseout = function () { mouseOutDUi1() };

function mouseOutDUi1() {
  document.getElementById("DUi3").style.width = "0%";
}

/* ----------------------------------------Dibujo---------------------------------------- */

/* al pasar el mouse */
document.getElementById("DBJ1").onmouseover = function () { mouseOverDBJ1() };
document.getElementById("DBJ2").onmouseover = function () { mouseOverDBJ1() };


function mouseOverDBJ1() {
  document.getElementById("DBJ3").style.width = "85%";

}


/* al sacar el mouse */
document.getElementById("DBJ1").onmouseout = function () { mouseOutDBJ1() };
document.getElementById("DBJ2").onmouseout = function () { mouseOutDBJ1() };

function mouseOutDBJ1() {
  document.getElementById("DBJ3").style.width = "0%";
}

/* ----------------------------------------Animacion---------------------------------------- */

/* al pasar el mouse */
document.getElementById("ANI1").onmouseover = function () { mouseOverANI1() };
document.getElementById("ANI2").onmouseover = function () { mouseOverANI1() };


function mouseOverANI1() {
  document.getElementById("ANI3").style.width = "63%";

}


/* al sacar el mouse */
document.getElementById("ANI1").onmouseout = function () { mouseOutANI1() };
document.getElementById("ANI2").onmouseout = function () { mouseOutANI1() };

function mouseOutANI1() {
  document.getElementById("ANI3").style.width = "0%";
}


/* --------------------------------botones--------------------------------- */

const boton1 = document.getElementById("boton1");
const boton2 = document.getElementById("boton2");
const boton3 = document.getElementById("boton3");
const AcercaDeMi = document.getElementById("AcercaDeMi");
const educacion = document.getElementById("educacion");
const experiencia = document.getElementById("experiencia");

boton1.addEventListener("click", function() {
  AcercaDeMi.style.display = "block";
  AcercaDeMi.style.height = "var(--altoDeTextoCajaContenido)";
  tittleAbout.style.display = "block";
  educacion.style.display = "none";
  tittleEducacion.style.display = "none";
  experiencia.style.display = "none";
  tittleExperiencia.style.display = "none";
});

boton2.addEventListener("click", function() {
  AcercaDeMi.style.display = "none";
  tittleAbout.style.display = "none";
  educacion.style.display = "block";
  educacion.style.height = "--altoDeTextoCajaContenido";
  tittleEducacion.style.display = "block";
  experiencia.style.display = "none";
  tittleExperiencia.style.display = "none";
});

boton3.addEventListener("click", function() {
  AcercaDeMi.style.display = "none";
  tittleAbout.style.display = "none";
  educacion.style.display = "none";
  tittleEducacion.style.display = "none";
  experiencia.style.display = "block";
  experiencia.style.height = "--altoDeTextoCajaContenido";
  tittleExperiencia.style.display = "block";
});


