const questions = [
  {
    text: "Закрепы против отсутствуют?",
    buttons: [
      { label: "Да", color: "green", value: "yes" },
      { label: "Нет", color: "red", value: "no", blocking: true },
      { label: "Есть на часе", color: "yellow", value: "hour" }
    ]
  },
  {
    text: "Импульсного пролива нет?",
    buttons: [
      { label: "Да", color: "green", value: "yes" },
      { label: "Нет", color: "red", value: "no", blocking: true }
    ]
  },
  {
    text: "СМТ все чисто?",
    buttons: [
      { label: "Да", color: "green", value: "yes" },
      { label: "Нет", color: "red", value: "no", blocking: true }
    ]
  },
  {
    text: "До 2х стопов за сегодня?",
    buttons: [
      { label: "Да", color: "green", value: "yes" },
      { label: "Нет", color: "red", value: "no", blocking: true }
    ]
  },
  {
    text: "Готов получить стопа за эту идею?",
    buttons: [
      { label: "Да", color: "green", value: "yes" },
      { label: "Нет", color: "red", value: "no", blocking: true }
    ]
  },
  {
    text: "5м модель есть, не спешим, лучше лимиткой на тесте?",
    buttons: [
      { label: "Да", color: "green", value: "yes" },
      { label: "Нет", color: "red", value: "no", blocking: true }
    ]
  },
  {
    text: "ВПН ВЫКЛЮЧИЛ?",
    buttons: [
      { label: "Да", color: "green", value: "yes" },
      { label: "Нет", color: "red", value: "no", blocking: true }
    ],
    isVpnQuestion: true
  }
];

let currentQuestion = 0;
let answers = [];
let isBlocked = false;

const questionNumber = document.getElementById('questionNumber');
const questionText = document.getElementById('questionText');
const buttonGroup = document.getElementById('buttonGroup');
const checklistView = document.getElementById('checklistView');
const resultView = document.getElementById('resultView');
const resultMessage = document.getElementById('resultMessage');
const rejectCountEl = document.getElementById('rejectCount');
const lamp = document.getElementById('lamp');

function renderQuestion() {
  const q = questions[currentQuestion];
  questionNumber.textContent = `Question ${currentQuestion + 1} / ${questions.length}`;
  questionText.textContent = q.text;

  const questionContainer = document.querySelector('.question-container');
  if (q.isVpnQuestion) {
    questionContainer.classList.add('vpn-question');
  } else {
    questionContainer.classList.remove('vpn-question');
  }

  buttonGroup.innerHTML = '';
  q.buttons.forEach(btn => {
    const button = document.createElement('button');
    button.textContent = btn.label;
    button.className = `btn-${btn.color}`;
    button.onclick = () => handleAnswer(btn.value, btn.blocking);
    buttonGroup.appendChild(button);
  });
}

function handleAnswer(value, isBlocking) {
  answers.push(value);

  if (isBlocking) {
    showReject();
  } else {
    if (currentQuestion < questions.length - 1) {
      currentQuestion++;
      renderQuestion();
    } else {
      showAllow();
      setTimeout(() => {
        openTerminal();
      }, 500);
    }
  }
}

function showReject() {
  isBlocked = true;
  lamp.classList.remove('success');
  lamp.classList.add('error');

  logChecklist('rejected');

  checklistView.style.display = 'none';
  resultView.style.display = 'block';
  resultMessage.textContent = 'ДОСТУП ЗАПРЕЩЁН';

  updateStats();
}

function showAllow() {
  lamp.classList.remove('error');
  lamp.classList.add('success');

  logChecklist('allowed');

  checklistView.style.display = 'none';
  resultView.style.display = 'block';
  resultMessage.textContent = 'ДОПУСК РАЗРЕШЁН';

  setTimeout(() => {
    openTerminal();
  }, 500);
}

function logChecklist(result) {
  fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instrument: 'UK100/USDCHF',
      direction: 'Long/Short',
      answers: answers,
      result: result
    })
  }).catch(err => console.error('Log error:', err));
}

function updateStats() {
  fetch('/api/stats')
    .then(r => r.json())
    .then(data => {
      rejectCountEl.textContent = data.rejectCount;
    })
    .catch(err => console.error('Stats error:', err));
}

function openTerminal() {
  fetch('/api/open-terminal', { method: 'POST' })
    .catch(err => console.error('Terminal error:', err));
}

function reset() {
  currentQuestion = 0;
  answers = [];
  isBlocked = false;
  lamp.classList.remove('success', 'error');
  checklistView.style.display = 'block';
  resultView.style.display = 'none';
  renderQuestion();
}

document.getElementById('finishBtn').addEventListener('click', reset);

renderQuestion();
updateStats();
