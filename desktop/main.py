#!/usr/bin/env python3
"""坐姿卫士 桌面版 v0.1 MVP - PyQt5 + MediaPipe"""
import sys, cv2, mediapipe as mp, numpy as np, time
from PyQt5.QtWidgets import (QApplication, QMainWindow, QWidget, QVBoxLayout,
                              QHBoxLayout, QLabel, QPushButton, QSlider,
                              QFrame, QMessageBox, QGridLayout)
from PyQt5.QtCore import QTimer, Qt, pyqtSignal
from PyQt5.QtGui import QPainter, QColor, QFont, QImage, QPixmap

# ---- 姿态指标计算 ----
def calc_angle(p1, p2, p3):
    v1 = np.array([p1[0]-p2[0], p1[1]-p2[1]])
    v2 = np.array([p3[0]-p2[0], p3[1]-p2[1]])
    cos = float(np.dot(v1,v2) / (np.linalg.norm(v1)*np.linalg.norm(v2)+1e-8))
    return np.degrees(np.arccos(np.clip(cos,-1,1)))

def detect_metrics(lm, h, w):
    nose = lm[0]
    lsh = lm[11]; rsh = lm[12]
    lp = lm[23]; rp = lm[24]
    lelbow = lm[13]; reelbow = lm[14]
    lw = lm[15]; rw = lm[16]
    sh = ((lsh.x+rsh.x)/2, (lsh.y+rsh.y)/2)
    hip = ((lp.x+rp.x)/2, (lp.y+rp.y)/2)
    cv = calc_angle((nose.x, nose.y), sh, hip)
    sh_tilt = abs(lsh.y - rsh.y) * h
    tr = calc_angle((lsh.x, lsh.y), sh, hip)
    le = calc_angle((lsh.x, lsh.y), (lelbow.x, lelbow.y), (lw.x, lw.y))
    re = calc_angle((rsh.x, rsh.y), (reelbow.x, reelbow.y), (rw.x, rw.y))
    return dict(cv=cv, sh_tilt=sh_tilt, trunk=tr, elbow=(le+re)/2)

def calc_score(m, ref=None):
    if not ref:
        return max(0, min(100, 100 - m['cv']*2 - m['trunk']*1.5))
    d1 = abs(m['cv']-ref['cv']); d2 = abs(m['trunk']-ref['trunk'])
    return max(0, min(100, 100 - d1*3 - d2*2))

def is_good(m, ref, sens):
    if not ref: return m['cv'] < 20 and m['trunk'] < 25
    return abs(m['cv']-ref['cv']) < sens and abs(m['trunk']-ref['trunk']) < sens*1.5

class VideoCanvas(QFrame):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(480, 360)
        self.setStyleSheet('background:#111;border:2px solid rgba(100,220,255,0.3);border-radius:12px')
        self.video_img = None

    def set_frame(self, frame):
        h,w,c = frame.shape
        self.video_img = QImage(frame.data, w, h, c*w, QImage.Format_RGB888).mirrored()
        self.update()

    def paintEvent(self, event):
        qp = QPainter(self)
        qp.setRenderHint(QPainter.Antialiasing)
        if self.video_img:
            rect = self.rect()
            qp.drawImage(rect, self.video_img.scaled(rect.width(), rect.height(), Qt.KeepAspectRatio, Qt.SmoothTransformation))

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle('坐姿卫士 Posture Guard v0.1')
        self.resize(680, 560)
        self.streaming = False
        self.calib = None
        self.sens = 12
        self.sound_on = True
        self.xp = 0; self.level = 1
        self.total_sec = 0; self.good_sec = 0; self.nudge_cnt = 0
        self.last_nudge = 0
        self.cap = None
        self.mp_pose = None
        self._setup_ui()
        self._setup_media()
        self.timer = QTimer(self)
        self.timer.timeout.connect(self._tick)
        self.timer.start(1000)

    def _setup_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        layout = QHBoxLayout(central)
        layout.setSpacing(12)
        # 左侧视频区
        left = QVBoxLayout()
        self.canvas = VideoCanvas()
        left.addWidget(self.canvas)
        btn_row = QHBoxLayout()
        self.btn_start = QPushButton('🎥 启动监测')
        self.btn_start.clicked.connect(self.toggle)
        self.btn_cal = QPushButton('📐 校准坐姿')
        self.btn_cal.clicked.connect(self.calibrate)
        self.btn_stop = QPushButton('⏹ 停止')
        self.btn_stop.clicked.connect(self.stop)
        self.btn_stop.setEnabled(False)
        btn_row.addWidget(self.btn_start)
        btn_row.addWidget(self.btn_cal)
        btn_row.addWidget(self.btn_stop)
        left.addLayout(btn_row)
        self.hint = QLabel('💡 坐好后点「校准」，让 AI 记住标准姿态')
        self.hint.setStyleSheet('color:#64dcff;font-size:11px')
        left.addWidget(self.hint)
        layout.addLayout(left, 2)
        # 右侧面板
        right = QVBoxLayout()
        right.setSpacing(8)
        # 标题
        title = QLabel('🦐 坐姿卫士 Desktop')
        title.setStyleSheet('font-size:14px;color:#64dcff;font-weight:bold')
        right.addWidget(title)
        # 指标卡片
        cards = [
            ('头前倾 CVA', 'm_cv'),
            ('躯干屈曲', 'm_tr'),
            ('肩倾斜', 'm_sh'),
            ('肘角', 'm_el'),
        ]
        for name, attr in cards:
            row = QHBoxLayout()
            lbl = QLabel(name)
            lbl.setStyleSheet('color:#aaa;font-size:11px')
            val = QLabel('--°')
            val.setObjectName(attr)
            val.setStyleSheet('color:#4ade80;font-size:11px;font-weight:bold')
            row.addWidget(lbl)
            row.addStretch()
            row.addWidget(val)
            setattr(self, attr, val)
            right.addLayout(row)
        right.addSpacing(4)
        # 评分
        score_row = QHBoxLayout()
        score_lbl = QLabel('评分:')
        score_lbl.setStyleSheet('color:#888;font-size:11px')
        self.score_val = QLabel('--')
        self.score_val.setStyleSheet('font-size:22px;font-weight:bold;color:#4ade80')
        score_row.addWidget(score_lbl)
        score_row.addWidget(self.score_val)
        right.addLayout(score_row)
        right.addSpacing(4)
        # XP
        xp_row = QHBoxLayout()
        xp_icon = QLabel('🦐')
        xp_icon.setStyleSheet('font-size:16px')
        self.lvl_lbl = QLabel('Lv.1')
        self.lvl_lbl.setStyleSheet('background:linear-gradient(135deg,#a855f7,#ec4899);border-radius:4px;padding:2px 8px;color:#fff;font-size:11px;font-weight:bold')
        self.xp_lbl = QLabel('0/100 XP')
        self.xp_lbl.setStyleSheet('color:#888;font-size:10px')
        xp_row.addWidget(xp_icon)
        xp_row.addWidget(self.lvl_lbl)
        xp_row.addWidget(self.xp_lbl)
        right.addLayout(xp_row)
        # 计时
        self.timer_lbl = QLabel('00:00')
        self.timer_lbl.setStyleSheet('font-size:20px;color:#64dcff;font-weight:bold;text-align:center')
        right.addWidget(self.timer_lbl)
        right.addSpacing(4)
        # 统计
        stats = QLabel('监测时长: 0分 | 好姿势: 0% | 提醒: 0次')
        stats.setObjectName('stat_lbl')
        stats.setStyleSheet('color:#888;font-size:10px;text-align:center')
        right.addWidget(stats)
        self.stat_lbl = stats
        # 设置栏
        right.addSpacing(8)
        set_row = QHBoxLayout()
        sens_lbl = QLabel('灵敏度:')
        sens_lbl.setStyleSheet('color:#aaa;font-size:10px')
        self.sens_slider = QSlider(Qt.Horizontal)
        self.sens_slider.setRange(5, 25); self.sens_slider.setValue(12)
        self.sens_slider.valueChanged.connect(self._on_sens)
        sens_val_lbl = QLabel('12°')
        sens_val_lbl.setObjectName('sens_val')
        sens_val_lbl.setStyleSheet('color:#64dcff;font-size:10px')
        set_row.addWidget(sens_lbl)
        set_row.addWidget(self.sens_slider)
        set_row.addWidget(sens_val_lbl)
        right.addLayout(set_row)
        right.addStretch()
        layout.addLayout(right, 1)

    def _setup_media(self):
        self.cap = cv2.VideoCapture(0)
        self.mp_pose = mp.solutions.pose.Pose(static_image_mode=False,
                                               model_complexity=1,
                                               min_detection_confidence=0.5,
                                               min_tracking_confidence=0.5)
        self.frame_timer = QTimer(self)
        self.frame_timer.timeout.connect(self._process_frame)
        self.frame_timer.start(33)

    def _on_sens(self, v):
        self.sens = v
        self.sender().parent().children()[-1].setText(str(v)+'°')

    def toggle(self):
        if not self.streaming:
            self.streaming = True
            self.total_sec = 0; self.good_sec = 0; self.nudge_cnt = 0
            self.last_nudge = 0
            self.btn_start.setEnabled(False)
            self.btn_stop.setEnabled(True)
            self.hint.setText('监测中...')
            self.frame_timer.start()
        else:
            self.stop()

    def stop(self):
        self.streaming = False
        self.frame_timer.stop()
        self.btn_start.setEnabled(True)
        self.btn_stop.setEnabled(False)
        self.hint.setText('💡 坐好后点「校准」...')

    def calibrate(self):
        ret, frame = self.cap.read()
        if not ret:
            QMessageBox.warning(self, '提示', '请先启动摄像头')
            return
        h,w = frame.shape[:2]
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = self.mp_pose.process(rgb)
        if results.pose_landmarks:
            lm = results.pose_landmarks.landmark
            self.calib = detect_metrics(lm, h, w)
            self.hint.setText('✅ 已校准！AI 记住了你的标准坐姿')
            self.sender() if hasattr(self,'sender') else None
            QTimer.singleShot(3000, lambda: self.hint.setText('💡 坐好后点「校准」...'))
        else:
            QMessageBox.warning(self, '提示', '未检测到人体，请面对摄像头调整位置')

    def _process_frame(self):
        if not self.streaming: return
        ret, frame = self.cap.read()
        if not ret: return
        h,w = frame.shape[:2]
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = self.mp_pose.process(rgb)
        if results.pose_landmarks:
            lm = results.pose_landmarks.landmark
            m = detect_metrics(lm, h, w)
            s = calc_score(m, self.calib)
            g = is_good(m, self.calib, self.sens)
            # 更新指标
            self.m_cv.setText(f'{m["cv"]:.1f}°')
            self.m_cv.setStyleSheet(f'color:{"#4ade80" if m["cv"]<15 else "#fbbf24" if m["cv"]<25 else "#f87171"};font-size:11px;font-weight:bold')
            self.m_tr.setText(f'{m["trunk"]:.1f}°')
            self.m_tr.setStyleSheet(f'color:{"#4ade80" if m["trunk"]<20 else "#fbbf24" if m["trunk"]<35 else "#f87171"};font-size:11px;font-weight:bold')
            self.m_sh.setText(f'{m["sh_tilt"]:.1f}px')
            self.m_el.setText(f'{m["elbow"]:.1f}°')
            # 评分
            self.score_val.setText(str(int(s)))
            self.score_val.setStyleSheet(f'font-size:22px;font-weight:bold;color:{"#4ade80" if s>=70 else "#fbbf24" if s>=40 else "#f87171"}')
            # 提醒
            now = time.time()
            if not g and now - self.last_nudge > 30:
                self.last_nudge = now
                self.nudge_cnt += 1
                # Beep
                if self.sound_on:
                    import winsound
                    try: winsound.Beep(880, 150)
                    except: pass
            # 计时
            self.total_sec += 1
            if g: self.good_sec += 1
            mins = self.total_sec // 60
            secs = self.total_sec % 60
            self.timer_lbl.setText(f'{mins:02d}:{secs:02d}')
            self.stat_lbl.setText(f'监测时长: {mins}分 | 好姿势: {self.good_sec/self.total_sec*100:.0f}% | 提醒: {self.nudge_cnt}次')
            # XP
            self.xp += 1
            need = self.level * 100
            if self.xp >= need:
                self.xp -= need
                self.level += 1
            self.lvl_lbl.setText(f'Lv.{self.level}')
            self.xp_lbl.setText(f'{self.xp}/{need} XP')
        # 显示帧（翻转）
        frame_flip = cv2.flip(frame, 1)
        self.canvas.set_frame(frame_flip)

    def closeEvent(self, event):
        if self.cap: self.cap.release()
        if self.mp_pose: self.mp_pose.close()
        event.accept()

if __name__ == '__main__':
    app = QApplication(sys.argv)
    app.setStyle('Fusion')
    app.setApplicationName('坐姿卫士')
    w = MainWindow()
    w.show()
    sys.exit(app.exec_())
