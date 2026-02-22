import React, { useState, useEffect } from 'react'
import { X, ChevronDown, Calendar as CalendarIcon, Loader2 } from 'lucide-react'
import './JumpToDateDialog.scss'

interface JumpToDateDialogProps {
    isOpen: boolean
    onClose: () => void
    onSelect: (date: Date) => void
    currentDate?: Date | null
}

const JumpToDateDialog: React.FC<JumpToDateDialogProps> = ({ isOpen, onClose, onSelect, currentDate }) => {
    const [viewDate, setViewDate] = useState(new Date())
    const [selectedDate, setSelectedDate] = useState<string>('')

    // Initialize state when dialog opens
    useEffect(() => {
        if (isOpen) {
            const initialDate = currentDate || new Date()
            setViewDate(initialDate)

            if (currentDate) {
                const y = currentDate.getFullYear()
                const m = String(currentDate.getMonth() + 1).padStart(2, '0')
                const d = String(currentDate.getDate()).padStart(2, '0')
                setSelectedDate(`${y}-${m}-${d}`)
            } else {
                setSelectedDate('')
            }
        }
    }, [isOpen, currentDate])

    if (!isOpen) return null

    const handleConfirm = () => {
        if (selectedDate) {
            const [y, m, d] = selectedDate.split('-').map(Number)
            const targetDate = new Date(y, m - 1, d)
            onSelect(targetDate)
            onClose()
        }
    }

    const renderCalendar = () => {
        const year = viewDate.getFullYear()
        const month = viewDate.getMonth()

        const firstDay = new Date(year, month, 1)
        const lastDay = new Date(year, month + 1, 0)
        const daysInMonth = lastDay.getDate()
        const startDayOfWeek = firstDay.getDay() // 0-6

        const days = []

        // Empty slots for previous month
        for (let i = 0; i < startDayOfWeek; i++) {
            days.push(<div key={`empty-${i}`} className="calendar-day empty"></div>)
        }

        // Days of current month
        const today = new Date()
        for (let i = 1; i <= daysInMonth; i++) {
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`
            const isSelected = selectedDate === dateStr
            const isToday = today.getDate() === i && today.getMonth() === month && today.getFullYear() === year
            const dateObj = new Date(year, month, i)
            // We allow future dates? User didn't specify. Chat history forbids future dates. 
            // Moments might contain future dates? Unlikely.
            // I'll disable future dates to be safe.
            const isFuture = dateObj > today

            days.push(
                <button
                    key={i}
                    className={`calendar-day ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''} ${isFuture ? 'disabled' : ''}`}
                    onClick={() => {
                        if (isFuture) return
                        setSelectedDate(dateStr)
                    }}
                    disabled={isFuture}
                    title={isFuture ? '未来时间' : undefined}
                >
                    {i}
                </button>
            )
        }

        return days
    }

    return (
        <div className="jump-date-overlay" onClick={onClose}>
            <div className="jump-date-modal custom-date-picker" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <div className="title-row">
                        <CalendarIcon size={18} />
                        <h3>选择日期</h3>
                    </div>
                    <button className="close-btn" onClick={onClose}>
                        <X size={18} />
                    </button>
                </div>

                <div className="calendar-container">
                    {/* Header: Month Nav */}
                    <div className="calendar-header">
                        <button
                            className="calendar-nav-btn"
                            onClick={() => {
                                const newDate = new Date(viewDate)
                                newDate.setMonth(newDate.getMonth() - 1)
                                setViewDate(newDate)
                            }}
                        >
                            <ChevronDown size={18} style={{ transform: 'rotate(90deg)' }} />
                        </button>
                        <span className="current-month">
                            {viewDate.getFullYear()}年 {viewDate.getMonth() + 1}月
                        </span>
                        <button
                            className="calendar-nav-btn nav-next"
                            onClick={() => {
                                const newDate = new Date(viewDate)
                                newDate.setMonth(newDate.getMonth() + 1)
                                const now = new Date()
                                if (newDate.getFullYear() > now.getFullYear() ||
                                    (newDate.getFullYear() === now.getFullYear() && newDate.getMonth() > now.getMonth())) {
                                    return
                                }
                                setViewDate(newDate)
                            }}
                            disabled={
                                viewDate.getFullYear() === new Date().getFullYear() &&
                                viewDate.getMonth() === new Date().getMonth()
                            }
                        >
                            <ChevronDown size={18} style={{ transform: 'rotate(-90deg)' }} />
                        </button>
                    </div>

                    {/* Weekdays */}
                    <div className="calendar-weekdays">
                        {['日', '一', '二', '三', '四', '五', '六'].map(d => (
                            <div key={d} className="weekday">{d}</div>
                        ))}
                    </div>

                    {/* Grid */}
                    <div className="calendar-grid">
                        {renderCalendar()}
                    </div>
                </div>

                <div className="calendar-footer">
                    <button
                        className="date-jump-today"
                        onClick={() => {
                            const now = new Date()
                            const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
                            setSelectedDate(dateStr)
                            setViewDate(now)
                        }}
                    >
                        回到今天
                    </button>
                    <button
                        className="date-jump-confirm"
                        onClick={handleConfirm}
                        disabled={!selectedDate}
                    >
                        跳转
                    </button>
                </div>
            </div>
        </div>
    )
}

export default JumpToDateDialog
