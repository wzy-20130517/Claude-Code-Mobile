import React from 'react';
import emptyStateIcon from '../assets/figma-exports/scheduled-page/empty-state-icon.svg';
import filterIcon from '../assets/figma-exports/scheduled-page/filter-icon.svg';
import infoIcon from '../assets/figma-exports/scheduled-page/info-icon.svg';
import keepAwakeIcon from '../assets/figma-exports/scheduled-page/keep-awake-icon.svg';
import keepAwakeToggleIcon from '../assets/figma-exports/scheduled-page/keep-awake-toggle.svg';
import searchIcon from '../assets/figma-exports/scheduled-page/search-icon.svg';

interface ScheduledPageProps {
  onNewTask: () => void;
}

const ScheduledPage: React.FC<ScheduledPageProps> = ({ onNewTask }) => {
  const handleSearch = () => {
    window.dispatchEvent(new CustomEvent('openSidebarSearch'));
  };

  return (
    <div className="scheduled-page flex-1 h-full overflow-y-auto">
      <div className="scheduled-shell">
        <div className="scheduled-header">
          <div className="scheduled-heading">
            <h1 className="scheduled-title">计划任务</h1>
            <p className="scheduled-subtitle">
              按计划运行任务，或在需要时随时运行。你也可以在现有任务中输入 /schedule 来设置计划。
            </p>
          </div>

          <div className="scheduled-toolbar" aria-label="计划任务操作">
            <button
              type="button"
              className="scheduled-icon-button"
              aria-label="筛选计划任务"
            >
              <img src={filterIcon} alt="" width={19} height={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="scheduled-icon-button"
              aria-label="搜索计划任务"
              onClick={handleSearch}
            >
              <img src={searchIcon} alt="" width={23} height={23} aria-hidden="true" />
            </button>
            <button type="button" className="scheduled-new-task-button" onClick={onNewTask}>
              新任务
            </button>
          </div>
        </div>

        <div className="scheduled-notice-card">
          <div className="scheduled-notice-copy">
            <img src={infoIcon} alt="" width={22} height={21} aria-hidden="true" />
            <span>计划任务只会在设备保持唤醒时运行。</span>
          </div>

          <div className="scheduled-notice-actions">
            <img src={keepAwakeIcon} alt="" width={23} height={23} aria-hidden="true" />
            <span>保持唤醒</span>
            <img src={keepAwakeToggleIcon} alt="" width={41} height={25} aria-hidden="true" />
          </div>
        </div>

        <div className="scheduled-empty-state">
          <img
            src={emptyStateIcon}
            alt=""
            width={102}
            height={117}
            className="scheduled-empty-icon"
            aria-hidden="true"
          />
          <p className="scheduled-empty-copy">还没有计划任务。</p>
        </div>
      </div>
    </div>
  );
};

export default ScheduledPage;
