import { Column, Row, Section, Text } from '@react-email/components';
import { EMAIL_COLORS } from '../palette';

interface Step {
  title: string;
  body: string;
}

interface StepsProps {
  steps: Step[];
}

const BADGE_SIZE = 28;

/** Numbered first steps (F1): a number badge, a title and one line. */
export function Steps({ steps }: StepsProps) {
  return (
    <Section style={{ margin: '0 0 16px' }}>
      {steps.map((step, i) => (
        <Row key={`${step.title}-${i}`}>
          <Column
            width="42"
            style={{
              width: '42px',
              paddingBottom: '12px',
              verticalAlign: 'top',
            }}
          >
            {/* A fixed-size cell, so Outlook keeps the badge round-ish and sized. */}
            <Row width={String(BADGE_SIZE)} align="left">
              <Column
                width={String(BADGE_SIZE)}
                height={String(BADGE_SIZE)}
                align="center"
                style={{
                  width: `${BADGE_SIZE}px`,
                  height: `${BADGE_SIZE}px`,
                  borderRadius: `${BADGE_SIZE / 2}px`,
                  backgroundColor: EMAIL_COLORS.primarySubtle,
                  color: EMAIL_COLORS.primary,
                  fontSize: '13px',
                  lineHeight: `${BADGE_SIZE}px`,
                  fontWeight: 600,
                  textAlign: 'center',
                }}
              >
                {i + 1}
              </Column>
            </Row>
          </Column>
          <Column style={{ paddingBottom: '12px', verticalAlign: 'top' }}>
            <Text
              style={{
                color: EMAIL_COLORS.heading,
                fontSize: '15px',
                lineHeight: '24px',
                fontWeight: 600,
                margin: 0,
              }}
            >
              {step.title}
            </Text>
            <Text
              style={{
                color: EMAIL_COLORS.muted,
                fontSize: '14px',
                lineHeight: '22px',
                margin: 0,
              }}
            >
              {step.body}
            </Text>
          </Column>
        </Row>
      ))}
    </Section>
  );
}
