import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { FileSpreadsheet, PlayCircle, Scale, ReceiptText } from 'lucide-react';
import { USER_ACCOUNTS } from '@/lib/constants';
import { useAppStore } from '@/store/useAppStore';
import DataIngestionPage from '@/pages/DataIngestionPage';
import RunsPage from '@/pages/RunsPage';
import ReportPage from '@/pages/ReportPage';
import AdjustPage from '@/pages/AdjustPage';

const NAV = [
  { to: '/', label: '数据导入与字段对应', sub: 'CSV/JSON · 拒绝行预览', icon: FileSpreadsheet },
  { to: '/runs', label: '对账运行', sub: '影响预览 · 版本演进', icon: PlayCircle },
  { to: '/report', label: '核平报告', sub: '账户日核平 · 差异下钻 · 导出', icon: Scale },
  { to: '/adjust', label: '调整与财务确认', sub: '贷项/更正 · 分级确认', icon: ReceiptText },
];

const TITLES: Record<string, [string, string]> = {
  '/': ['数据导入与字段对应', '导入平台账单、活动小时消耗与服务日汇率，预览列含义与被拒绝的原始行，字段对应可保存复用'],
  '/runs': ['对账运行', '修改映射、补入贷项或替换汇率后先预览受影响账户日，再产生引用同一输入的新版本运行'],
  '/report': ['核平报告', '正式核平固定在账户/日期/币种粒度；活动级仅确认平台可核验拆分，未归属余额不伪装成逐活动实收'],
  '/adjust': ['调整与财务确认', '迟到贷项与平台更正关联原账单行；账户总额与活动归属可分别确认，不平分区禁止核清'],
};

export default function App() {
  const currentUserId = useAppStore((s) => s.currentUserId);
  const switchUser = useAppStore((s) => s.switchUser);
  const resetDemo = useAppStore((s) => s.resetDemo);
  const location = useLocation();
  const [title, sub] = TITLES[location.pathname] ?? TITLES['/'];
  const account = USER_ACCOUNTS.find((a) => a.userId === currentUserId);

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="brand">
          <Scale size={20} />
          <div>
            广告账单对账工作台
            <small>Platform Bill Reconciliation</small>
          </div>
        </div>
        {NAV.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <Icon size={17} />
              <div>
                {item.label}
                <div className="desc">{item.sub}</div>
              </div>
            </NavLink>
          );
        })}
        <div className="sidebar-foot">
          <button
            className="sm"
            style={{ width: '100%', background: 'transparent', color: '#94a3b8', borderColor: '#26334d' }}
            onClick={() => {
              if (confirm('清空所有导入、运行、调整与确认记录，恢复演示初始状态？')) resetDemo();
            }}
          >
            重置演示数据
          </button>
          <p style={{ marginTop: 10, lineHeight: 1.6 }}>
            本功能只核验费用数据，<br />不执行支付、开票或财务记账。
          </p>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <div className="page-title">{title}</div>
            <div className="page-sub">{sub}</div>
          </div>
          <div className="user-switch">
            <span className="muted">当前身份（模拟登录）：</span>
            <select
              value={currentUserId}
              onChange={(e) => switchUser(e.target.value)}
              style={{ minWidth: 300 }}
              title={account?.description}
            >
              {USER_ACCOUNTS.map((a) => (
                <option key={a.userId} value={a.userId}>
                  {a.name}（{a.role === 'owner' ? '财务负责人' : '财务分析员'}）
                </option>
              ))}
            </select>
          </div>
        </header>
        <main className="content">
          <Routes>
            <Route path="/" element={<DataIngestionPage />} />
            <Route path="/runs" element={<RunsPage />} />
            <Route path="/report" element={<ReportPage />} />
            <Route path="/adjust" element={<AdjustPage />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
