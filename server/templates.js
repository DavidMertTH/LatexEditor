
const article = (name) => String.raw`\documentclass[11pt,a4paper]{article}

\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[ngerman]{babel}
\usepackage{lmodern}
\usepackage{microtype}
\usepackage{amsmath, amssymb, amsthm}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage[margin=2.5cm]{geometry}
\usepackage[hidelinks]{hyperref}

\newcommand{\R}{\mathbb{R}}
\newtheorem{satz}{Satz}

\title{${name}}
\author{Dein Name}
\date{\today}

\begin{document}

\maketitle

\begin{abstract}
  Dies ist ein kurzer Überblick über das Dokument. Schreibe hier eine
  Zusammenfassung deiner Arbeit.
\end{abstract}

\section{Einleitung}
\label{sec:einleitung}

Willkommen in deinem neuen Projekt! Text kann \textbf{fett}, \textit{kursiv}
oder \emph{hervorgehoben} sein. Mathematik im Fließtext sieht so aus:
$e^{i\pi} + 1 = 0$. Abgesetzte Formeln werden nummeriert, siehe
Gleichung~\eqref{eq:gauss}.

\begin{equation}
  \int_{-\infty}^{\infty} e^{-x^2} \, dx = \sqrt{\pi}
  \label{eq:gauss}
\end{equation}

\subsection{Listen}

\begin{itemize}
  \item Ein erster Punkt
  \item Ein zweiter Punkt mit $\alpha + \beta = \gamma$
  \item Ein dritter Punkt
\end{itemize}

\begin{enumerate}
  \item Schritt eins
  \item Schritt zwei
\end{enumerate}

\section{Ergebnisse}
\label{sec:ergebnisse}

\begin{satz}
  Für alle $x \in \R$ gilt $x^2 \geq 0$.
\end{satz}

Tabelle~\ref{tab:werte} zeigt einige Werte.

\begin{table}[h]
  \centering
  \begin{tabular}{lrr}
    \toprule
    Methode & Zeit (s) & Genauigkeit \\
    \midrule
    A & 1.2 & 92\,\% \\
    B & 0.8 & 89\,\% \\
    C & 2.4 & 97\,\% \\
    \bottomrule
  \end{tabular}
  \caption{Vergleich der Methoden}
  \label{tab:werte}
\end{table}

\begin{align}
  f(x) &= x^2 + 2x + 1 \\
       &= (x + 1)^2
\end{align}

Wie in \cite{knuth1984} beschrieben, ist \LaTeX{} ideal für
wissenschaftliche Texte.

\section{Fazit}

In Abschnitt~\ref{sec:einleitung} haben wir begonnen, in
Abschnitt~\ref{sec:ergebnisse} Ergebnisse vorgestellt.

\bibliographystyle{plain}
\bibliography{references}

\end{document}
`;

const references = String.raw`@book{knuth1984,
  author    = {Donald E. Knuth},
  title     = {The {\TeX}book},
  publisher = {Addison-Wesley},
  year      = {1984}
}

@book{lamport1994,
  author    = {Leslie Lamport},
  title     = {{\LaTeX}: A Document Preparation System},
  publisher = {Addison-Wesley},
  edition   = {2},
  year      = {1994}
}
`;

const report = (name) => String.raw`\documentclass[11pt,a4paper]{report}

\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[ngerman]{babel}
\usepackage{lmodern}
\usepackage{microtype}
\usepackage{amsmath, amssymb}
\usepackage{graphicx}
\usepackage[margin=2.5cm]{geometry}
\usepackage[hidelinks]{hyperref}

\title{${name}}
\author{Dein Name}
\date{\today}

\begin{document}

\maketitle
\tableofcontents

\input{chapters/einleitung}
\input{chapters/grundlagen}

\end{document}
`;

const beamer = (name) => String.raw`\documentclass{beamer}

\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[ngerman]{babel}
\usetheme{default}
\setbeamertemplate{navigation symbols}{}

\title{${name}}
\author{Dein Name}
\date{\today}

\begin{document}

\begin{frame}
  \titlepage
\end{frame}

\begin{frame}{Gliederung}
  \tableofcontents
\end{frame}

\section{Einführung}

\begin{frame}{Erste Folie}
  \begin{itemize}
    \item Ein wichtiger Punkt
    \item Noch ein Punkt
    \item Formel: $E = mc^2$
  \end{itemize}
\end{frame}

\begin{frame}{Zweite Folie}
  \begin{columns}
    \column{0.5\textwidth}
    Links steht Text.
    \column{0.5\textwidth}
    \[
      \sum_{k=1}^{n} k = \frac{n(n+1)}{2}
    \]
  \end{columns}
\end{frame}

\end{document}
`;

const letter = () => String.raw`\documentclass[11pt,a4paper]{letter}

\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[ngerman]{babel}
\usepackage{lmodern}

\signature{Dein Name}
\address{Dein Name \\ Musterstraße 1 \\ 12345 Musterstadt}

\begin{document}

\begin{letter}{Empfänger \\ Beispielweg 2 \\ 54321 Beispielstadt}

\opening{Sehr geehrte Damen und Herren,}

hier steht der Text des Briefes.

\closing{Mit freundlichen Grüßen}

\end{letter}

\end{document}
`;

export const TEMPLATES = {
  article: {
    name: 'Artikel',
    description: 'Wissenschaftlicher Artikel mit Mathe, Tabellen und Literatur',
    files: { 'main.tex': article, 'references.bib': references },
  },
  report: {
    name: 'Bericht / Arbeit',
    description: 'Mehrere Kapitel in eigenen Dateien mit Inhaltsverzeichnis',
    files: {
      'main.tex': report,
      'chapters/einleitung.tex': String.raw`\chapter{Einleitung}
\label{chap:einleitung}

Hier beginnt die Arbeit. Im Kapitel~\ref{chap:grundlagen} folgen die Grundlagen.
`,
      'chapters/grundlagen.tex': String.raw`\chapter{Grundlagen}
\label{chap:grundlagen}

\section{Definitionen}

Sei $f\colon \mathbb{R} \to \mathbb{R}$ eine stetige Funktion.

\[
  \lim_{h \to 0} \frac{f(x+h) - f(x)}{h} = f'(x)
\]
`,
    },
  },
  beamer: {
    name: 'Präsentation',
    description: 'Folien mit Beamer',
    files: { 'main.tex': beamer },
  },
  letter: {
    name: 'Brief',
    description: 'Ein einfacher formaler Brief',
    files: { 'main.tex': letter },
  },
  empty: {
    name: 'Leer',
    description: 'Minimales Dokument',
    files: {
      'main.tex': () => String.raw`\documentclass{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}

\begin{document}

Hallo Welt!

\end{document}
`,
    },
  },
};
